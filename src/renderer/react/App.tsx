import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { UsbRecorder } from '../recorder';

type Config = {
    saveDir: string | null;
    cameraMode: 'usb' | 'rtsp';
    rtspUrl: string;
    employeeName: string;
    rtspTranscode: boolean;
    overlayEnabled?: boolean;
    overlayTemplate?: string; // supports {order}, {employee}, {time}
    scale1080?: boolean;
};

type Session = {
    employee: string;
    order: string;
    start: string;
    end: string;
    durationMs: number;
    filePath: string;
};

function fmtTime(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function buildFilename(order: string, employee?: string) {
    const dt = new Date();
    const stamp = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(
        dt.getDate()
    ).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(
        2,
        '0'
    )}${String(dt.getSeconds()).padStart(2, '0')}`;
    const safeOrder = String(order).replace(/[^\w.-]+/g, '_');
    const safeEmp = String(employee || '').replace(/[^\w.-]+/g, '_');
    return `${safeOrder}__${safeEmp}__${stamp}.mp4`;
}

function parseOrderCode(qrText: string) {
    const m = /(?:order|code|ma|don|order_code)\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(qrText);
    if (m) return m[1];
    return qrText.trim();
}

export function App() {
    const [config, setConfig] = useState<Config>({
        saveDir: null,
        cameraMode: 'usb',
        rtspUrl: '',
        employeeName: '',
        rtspTranscode: false,
        overlayEnabled: true,
        overlayTemplate: '{order}-{time}',
        scale1080: false,
    });
    const [ffmpegAvailable, setFfmpegAvailable] = useState(false);
    const [recording, setRecording] = useState(false);
    const [orderCode, setOrderCode] = useState<string | null>(null);
    const [startTime, setStartTime] = useState<number | null>(null);
    const [timer, setTimer] = useState('00:00');
    const [metricsHtml, setMetricsHtml] = useState('');
    const [statsMonth, setStatsMonth] = useState(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
    const [knownEmployees, setKnownEmployees] = useState<string[]>([]);
    const [newUser, setNewUser] = useState('');
    const [editingUser, setEditingUser] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [cameraReady, setCameraReady] = useState(false);
    const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
    const [showSettings, setShowSettings] = useState(true);
    const sessionIdRef = useRef<string | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const usbRef = useRef<UsbRecorder | null>(null);
    const currentOutPathRef = useRef<string | null>(null);
    const scannerInputRef = useRef<HTMLInputElement | null>(null);
    const lastScanAtRef = useRef<number>(0);

    // Determine if current focus is on a user-editable field
    function isEditableElement(el: Element | null) {
        if (!el) return false;
        const anyEl = el as HTMLElement;
        if (anyEl.isContentEditable) return true;
        const tag = anyEl.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            const inp = anyEl as HTMLInputElement;
            return !inp.readOnly && !inp.disabled;
        }
        return false;
    }

    // Load config + ffmpeg
    useEffect(() => {
        (async () => {
            const cfg = await window.api.getConfig();
            setConfig(cfg);
            try {
                const r = await window.api.checkFFmpeg();
                setFfmpegAvailable(!!r.available);
            } catch {
                setFfmpegAvailable(false);
            }
            if (cfg.cameraMode === 'usb' && cfg.employeeName?.trim()) {
                try {
                    usbRef.current = new UsbRecorder(videoRef.current!);
                    await usbRef.current.init(cfg.videoDeviceId || undefined);
                    setCameraReady(true);
                } catch (e) {
                    console.error(e);
                    setCameraReady(false);
                }
            } else {
                setCameraReady(false);
            }
            refreshMetrics();
            // Load known employees from DB (fallback handled in main process)
            try {
                const names = await window.api.getUsers();
                setKnownEmployees(Array.isArray(names) ? names : []);
            } catch {}
        })();
    }, []);

    async function refreshUsers() {
        try {
            const names = await window.api.getUsers();
            setKnownEmployees(Array.isArray(names) ? names : []);
        } catch {}
    }

    // Auto-initialize USB camera after login (when employeeName is set)
    useEffect(() => {
        (async () => {
            if (config.cameraMode !== 'usb') return;
            if (!config.employeeName?.trim()) return;
            if (!videoRef.current) return;
            if (cameraReady) return;
            try {
                if (!usbRef.current) {
                    usbRef.current = new UsbRecorder(videoRef.current!);
                }
                await usbRef.current.init(config.videoDeviceId || undefined);
                setCameraReady(true);
            } catch (e) {
                console.error('Auto open camera failed', e);
                setCameraReady(false);
            }
        })();
    }, [config.employeeName, config.cameraMode, config.videoDeviceId]);

    // Keyboard wedge scanner (supports scanners with/without Enter suffix)
    useEffect(() => {
        // Keep a hidden input focused so scanner keystrokes land in our window
        const focusScanner = () => {
            try {
                scannerInputRef.current?.focus({ preventScroll: true });
            } catch {}
        };
        // Initial focus only if not typing into an editable field
        if (!isEditableElement(document.activeElement)) {
            focusScanner();
        }
        const onBlur = () =>
            setTimeout(() => {
                // Only steal focus back when not on an editable input
                if (!isEditableElement(document.activeElement)) {
                    focusScanner();
                }
            }, 0);
        scannerInputRef.current?.addEventListener('blur', onBlur);

        let buffer = '';
        let lastTs = 0;
        let idleTimer: any = null;
        const IDLE_COMMIT_MS = 180; // commit buffered scan if idle this long
        const RESET_GAP_MS = 300; // reset buffer if pause longer than this

        const commitIfAny = () => {
            const text = buffer.trim();
            buffer = '';
            if (text.length >= 3) onScan(text);
        };

        const onKey = (e: KeyboardEvent) => {
            // If user is typing in an input, don't interfere
            // if (isEditableElement(document.activeElement)) return;
            const now = Date.now();
            const delta = now - lastTs;
            lastTs = now;

            // If a long pause happened between keystrokes, treat previous buffer as noise
            if (delta > RESET_GAP_MS) buffer = '';

            if (e.key === 'Enter' || e.key === 'Tab') {
                // Many scanners send Enter/Tab as a terminator — commit immediately
                commitIfAny();
                e.preventDefault();
                return;
            }
            if (e.key.length === 1) buffer += e.key;

            // Re-arm idle timer to commit when scanner stops sending quickly
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                // If user hasn't started typing into an input meanwhile, commit
                if (!isEditableElement(document.activeElement)) commitIfAny();
            }, IDLE_COMMIT_MS);
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            if (idleTimer) clearTimeout(idleTimer);
            scannerInputRef.current?.removeEventListener('blur', onBlur);
        };
    }, [recording, orderCode, config]);

    useEffect(() => {
        let id: any;
        if (recording && startTime) {
            id = setInterval(() => setTimer(fmtTime(Date.now() - startTime)), 250);
        } else {
            setTimer('00:00');
        }
        return () => id && clearInterval(id);
    }, [recording, startTime]);

    async function onScan(text: string) {
        const now = Date.now();
        // Throttle: tối thiểu 2 giây giữa các lần xử lý scan
        if (now - lastScanAtRef.current < 2000) return;

        lastScanAtRef.current = now;

        const order = parseOrderCode(text);
        if (!recording) await startRecording(order);
        else if (orderCode === order) await stopRecording();
        else alert(`Đang ghi cho mã ${orderCode}. Quét lại cùng mã để dừng.`);
    }

    async function startRecording(order: string) {
        console.log(config);
        if (!config.saveDir) {
            alert('Vui lòng chọn thư mục lưu trước.');
            return;
        }

        // Prepare session id
        const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        if (config.cameraMode === 'usb') {
            try {
                if (!usbRef.current) {
                    usbRef.current = new UsbRecorder(videoRef.current!);
                }
                await usbRef.current.init(config.videoDeviceId || undefined);
                // Build overlay text if enabled
                // Build overlay template + vars if enabled
                let overlay: any = undefined;
                if (config.overlayEnabled) {
                    const tmpl = config.overlayTemplate || 'Mã: {order} • NV: {employee} • {time}';
                    overlay = {
                        template: tmpl,
                        vars: { order, employee: config.employeeName || '' },
                        startMs: Date.now(),
                    };
                }

                // Start capture first; only mark recording when successful
                usbRef.current.start(overlay);

                sessionIdRef.current = sessionId;
                setOrderCode(order);
                setStartTime(Date.now());
                setRecording(true);
            } catch (e) {
                console.error('USB start failed', e);
                alert('Không thể bắt đầu ghi từ camera USB. Vui lòng kiểm tra thiết bị/quyền.');
            }
            return;
        }

        // RTSP branch
        if (!ffmpegAvailable) {
            alert('FFmpeg không có sẵn. Không thể ghi RTSP.');
            return;
        }
        const rtspUrl = config.rtspUrl?.trim();
        if (!rtspUrl) {
            alert('Nhập RTSP URL');
            return;
        }

        const outPath = window.api.pathJoin(
            config.saveDir!,
            buildFilename(order, config.employeeName)
        );

        try {
            await window.api.recordRtspStart(
                sessionId,
                rtspUrl,
                outPath,
                !!config.rtspTranscode,
                !!config.scale1080
            );
            currentOutPathRef.current = outPath; // remember for stop/log

            sessionIdRef.current = sessionId;
            setOrderCode(order);
            setStartTime(Date.now());
            setRecording(true);
        } catch (e) {
            console.error('RTSP start failed', e);
            alert('Không thể bắt đầu ghi RTSP. Hãy kiểm tra URL/kết nối/FFmpeg.');
        }
    }

    async function stopRecording() {
        const sessionId = sessionIdRef.current!;

        // Determine file path: prefer the RTSP path used at start; otherwise, build a fresh name
        let filePath =
            currentOutPathRef.current ??
            window.api.pathJoin(config.saveDir!, buildFilename(orderCode!, config.employeeName));

        const durationMs = Date.now() - (startTime as number);

        if (config.cameraMode === 'usb') {
            // Capture the blob once and reuse it
            const blob: Blob = await usbRef.current!.stop();
            let savedAsMp4 = false;

            const anyBlob: any = blob as any;
            const data = await blob.arrayBuffer();
            if (anyBlob && anyBlob.type && String(anyBlob.type).startsWith('video/mp4')) {
                if (ffmpegAvailable && config.scale1080) {
                    // Save to tmp then upscale to 1080p in background
                    const tmpPath = window.api.pathJoin(window.api.tmpDir(), `${sessionId}.mp4`);
                    await window.api.writeFile(tmpPath, data);
                    window.api
                        .transcodeTo1080Bg(tmpPath, filePath, true)
                        .catch((e: any) => console.error('BG 1080p transcode failed', e));
                    savedAsMp4 = true;
                } else {
                    // Direct MP4: write final file and return fast
                    await window.api.writeFile(filePath, data);
                    savedAsMp4 = true;
                }
            } else if (ffmpegAvailable) {
                try {
                    // Write WEBM once, kick off background transcode to MP4, return immediately
                    const tmpPath = window.api.pathJoin(window.api.tmpDir(), `${sessionId}.webm`);
                    await window.api.writeFile(tmpPath, data);
                    // Fire-and-forget; input will be deleted when done
                    if (config.scale1080) {
                        window.api
                            .transcodeTo1080Bg(tmpPath, filePath, true)
                            .catch((e: any) => console.error('BG 1080p transcode failed', e));
                    } else {
                        window.api
                            .transcodeWebmToMp4Bg(tmpPath, filePath, true)
                            .catch((e: any) => console.error('BG transcode failed', e));
                    }
                    savedAsMp4 = true; // We'll deliver MP4 later; session logs now
                } catch (e) {
                    console.error('Transcode (bg) kickoff failed', e);
                    savedAsMp4 = false;
                }
            }

            if (!savedAsMp4) {
                // Fallback: save as WEBM quickly (no transcode)
                filePath = filePath.replace(/\.mp4$/i, '.webm');
                await window.api.writeFile(filePath, data);
            }
        } else {
            await window.api.recordRtspStop(sessionId);
        }

        await window.api.logSession({
            employee: config.employeeName || '',
            order: orderCode,
            start: new Date(startTime!).toISOString(),
            end: new Date().toISOString(),
            durationMs,
            filePath,
        });

        // Reset states
        setRecording(false);
        setStartTime(null);
        setOrderCode(null);
        sessionIdRef.current = null;
        currentOutPathRef.current = null;

        refreshMetrics();
    }

    async function refreshMetrics(mStr?: string) {
        const sessions: Session[] = await window.api.getSessions();
        const target = mStr || statsMonth;
        let y = new Date().getFullYear();
        let m = new Date().getMonth();
        if (target && /^(\d{4})-(\d{2})$/.test(target)) {
            const parts = target.split('-');
            y = Number(parts[0]);
            m = Number(parts[1]) - 1;
        }
        const monthStart = new Date(y, m, 1);
        const nextMonth = new Date(y, m + 1, 1);
        const monthSessions = sessions.filter(
            (s) => new Date(s.start) >= monthStart && new Date(s.start) < nextMonth
        );
        const byEmp = new Map<string, { total: number; count: number }>();
        for (const s of monthSessions) {
            const k = s.employee || '—';
            const v = byEmp.get(k) || { total: 0, count: 0 };
            v.total += s.durationMs || 0;
            v.count += 1;
            byEmp.set(k, v);
        }
        const totalCount = monthSessions.length;
        const totalDuration = monthSessions.reduce((acc, s) => acc + (s.durationMs || 0), 0);
        const mm = String(m + 1).padStart(2, '0');
        let html = '';
        if (byEmp.size) {
            html += '<div class="mt-1">';
            for (const [emp, v] of byEmp.entries()) {
                html += `<div>${emp}: ${v.count} đơn • Tổng ${fmtTime(v.total)}</div>`;
            }
            html += '</div>';
        }
        if (!html)
            html = '<div class="text-sm text-muted-foreground">Chưa có dữ liệu tháng này.</div>';
        setMetricsHtml(html);
    }

    async function chooseDir() {
        try {
            if (!(window as any).api) {
                alert(
                    'Bridge chưa sẵn sàng (window.api không tồn tại). Hãy thử khởi động lại ứng dụng.'
                );
                return;
            }
            const dir = await window.api.selectSaveDir();
            if (dir) setConfig((c) => ({ ...c, saveDir: dir }));
            else console.debug('User canceled or no directory selected');
        } catch (e) {
            console.error('selectSaveDir failed', e);
            alert(
                'Không thể mở hộp thoại chọn thư mục. Hãy đảm bảo cửa sổ ứng dụng đang ở phía trước.'
            );
        }
    }

    async function saveConfig() {
        const saved = await window.api.setConfig(config);
        setConfig(saved);
    }

    async function loginAs(name: string) {
        const emp = name.trim();
        if (!emp) return;
        const saved = await window.api.setConfig({ ...config, employeeName: emp });
        setConfig(saved);
    }

    async function logout() {
        // Stop camera/recorder and reset before leaving to login screen
        try {
            await usbRef.current?.dispose();
        } catch {}
        usbRef.current = null;
        if (videoRef.current) {
            try {
                // @ts-ignore
                videoRef.current.srcObject = null;
            } catch {}
        }
        setCameraReady(false);
        const saved = await window.api.setConfig({ ...config, employeeName: '' });
        setConfig(saved);
    }

    async function openCamera() {
        if (config.cameraMode !== 'usb') {
            alert('Mở camera xem trước chỉ hỗ trợ chế độ USB.');
            return;
        }
        try {
            if (!usbRef.current) {
                usbRef.current = new UsbRecorder(videoRef.current!);
            }
            await usbRef.current.init(config.videoDeviceId || undefined);
            setCameraReady(true);
        } catch (e) {
            console.error(e);
            setCameraReady(false);
            alert('Không thể mở camera. Hãy kiểm tra quyền truy cập hoặc thiết bị USB.');
        }
    }

    // Removed: Camera-based QR scanning (BarcodeDetector/jsQR)

    async function scanVideoDevices() {
        try {
            // Ensure permissions so labels are populated
            await navigator.mediaDevices
                .getUserMedia({ video: true, audio: false })
                .then((s) => s.getTracks().forEach((t) => t.stop()))
                .catch(() => {});
            const list = await navigator.mediaDevices.enumerateDevices();
            const vids = list.filter((d) => d.kind === 'videoinput');
            setVideoDevices(vids);
        } catch (e) {
            console.error('enumerateDevices failed', e);
            alert(
                'Không thể liệt kê camera. Hãy cấp quyền camera cho ứng dụng trong System Settings > Privacy & Security > Camera.'
            );
        }
    }

    // If no employee selected, show a simple login screen
    if (!config.employeeName?.trim()) {
        return (
            <div className='min-h-screen grid place-items-center p-4'>
                <Card className='w-full max-w-md p-4 space-y-4'>
                    <div className='text-xl font-semibold'>Đăng nhập</div>
                    {knownEmployees.length > 0 && (
                        <div>
                            <div className='text-sm text-muted-foreground mb-2'>Chọn nhanh</div>
                            <div className='flex flex-col gap-2'>
                                {knownEmployees.map((n) => (
                                    <div key={n} className='flex items-center gap-2'>
                                        <Button
                                            className='flex-1 justify-start'
                                            variant='outline'
                                            onClick={() => loginAs(n)}
                                        >
                                            {n}
                                        </Button>
                                        {editingUser === n ? (
                                            <>
                                                <Input
                                                    className='flex-1'
                                                    value={editValue}
                                                    onChange={(e) => setEditValue(e.target.value)}
                                                    placeholder='Tên nhân viên'
                                                />
                                                <Button
                                                    variant='outline'
                                                    onClick={async () => {
                                                        const newName = editValue.trim();
                                                        if (!newName || newName === n) {
                                                            setEditingUser(null);
                                                            return;
                                                        }
                                                        const r = await window.api.renameUser(
                                                            n,
                                                            newName
                                                        );
                                                        if (!r.ok)
                                                            alert(r.error || 'Đổi tên thất bại');
                                                        await refreshUsers();
                                                        setEditingUser(null);
                                                    }}
                                                >
                                                    Lưu
                                                </Button>
                                                <Button
                                                    variant='outline'
                                                    onClick={() => setEditingUser(null)}
                                                >
                                                    Hủy
                                                </Button>
                                            </>
                                        ) : (
                                            <Button
                                                variant='outline'
                                                onClick={() => {
                                                    setEditingUser(n);
                                                    setEditValue(n);
                                                }}
                                            >
                                                Sửa
                                            </Button>
                                        )}
                                        <Button
                                            variant='outline'
                                            onClick={async () => {
                                                if (!confirm(`Xoá nhân viên "${n}"?`)) return;
                                                const r = await window.api.deleteUser(n);
                                                if (!r.ok) alert(r.error || 'Xoá thất bại');
                                                try {
                                                    const names = await window.api.getUsers();
                                                    setKnownEmployees(
                                                        Array.isArray(names) ? names : []
                                                    );
                                                } catch {}
                                            }}
                                        >
                                            Xoá
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className='space-y-2'>
                        <Label>Thêm nhanh nhân viên mới</Label>
                        <div className='flex gap-2'>
                            <Input
                                placeholder='Nhập tên nhân viên mới'
                                value={newUser}
                                onChange={(e) => setNewUser(e.target.value)}
                                onKeyDown={async (e) => {
                                    if (e.key === 'Enter') {
                                        const name = newUser.trim();
                                        if (!name) return;
                                        const r = await window.api.addUser(name);
                                        if (!r.ok) alert(r.error || 'Thêm thất bại');
                                        setNewUser('');
                                        await (async () => {
                                            try {
                                                await refreshUsers();
                                            } catch {}
                                        })();
                                    }
                                }}
                            />
                            <Button
                                variant='outline'
                                onClick={async () => {
                                    const name = newUser.trim();
                                    if (!name) return;
                                    const r = await window.api.addUser(name);
                                    if (!r.ok) alert(r.error || 'Thêm thất bại');
                                    setNewUser('');
                                    await refreshUsers();
                                }}
                            >
                                Thêm
                            </Button>
                        </div>
                    </div>
                </Card>
            </div>
        );
    }

    return (
        <div
            className={`min-h-screen overflow-x-hidden ${showSettings ? '' : 'overflow-y-hidden'}`}
        >
            <header className='px-4 py-3 bg-slate-800 text-white flex items-center justify-between'>
                <div>QR Packaging Recorder</div>
                <div className='text-sm opacity-80'>
                    {config.employeeName ? `NV: ${config.employeeName}` : ''}
                </div>
                <div className='flex gap-2'>
                    <Button variant='outline' onClick={() => setShowSettings((v) => !v)}>
                        {showSettings ? 'Ẩn thiết lập' : 'Hiện thiết lập'}
                    </Button>
                    <Button variant='outline' onClick={logout}>
                        Đổi người dùng
                    </Button>
                </div>
            </header>
            <div
                className={`grid grid-cols-1 ${
                    showSettings ? 'md:grid-cols-[1fr_360px]' : ''
                } gap-4 p-4`}
            >
                {/* Hidden input to keep focus for scanner devices */}
                <input ref={scannerInputRef} className='sr-only' aria-hidden='true' />
                <Card>
                    <div className='flex items-start justify-between gap-3'>
                        <div>
                            <div className='font-semibold'>
                                Trạng thái: <span>{recording ? 'Đang ghi hình' : 'Sẵn sàng'}</span>
                            </div>
                            <div className='text-sm text-muted-foreground'>
                                Mã đơn hiện tại: <span>{orderCode ?? '—'}</span>
                            </div>
                        </div>
                        <div className='flex items-center gap-3'>
                            <div className='text-3xl font-bold tabular-nums'>{timer}</div>
                            <Button onClick={stopRecording} disabled={!recording}>
                                Dừng
                            </Button>
                        </div>
                    </div>
                    <div className='mt-2'>
                        <div
                            className={
                                'w-full rounded-md bg-black overflow-hidden ' +
                                (showSettings
                                    ? 'aspect-video max-h-[calc(100vh-220px)]'
                                    : 'aspect-video max-h-[calc(100vh-220px)]')
                            }
                        >
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                muted
                                className='w-full h-full object-contain'
                            />
                        </div>
                        <div className='text-sm text-muted-foreground mt-2'>
                            Hướng dẫn: Dùng máy scan quét mã QR để bắt đầu/ kết thúc. Quét lại cùng
                            mã để dừng.
                        </div>
                    </div>
                </Card>
                {showSettings && (
                    <Card>
                        <div className='space-y-2'>
                            <div className='text-lg font-semibold'>Thiết lập</div>
                            <div className='grid gap-2 items-center'>
                                <Label>Chế độ camera</Label>
                                <Select
                                    value={config.cameraMode}
                                    onChange={(e) =>
                                        setConfig({ ...config, cameraMode: e.target.value as any })
                                    }
                                >
                                    <option value='usb'>USB </option>
                                    <option value='rtsp'>IP (RTSP)</option>
                                </Select>

                                {config.cameraMode === 'usb' && (
                                    <>
                                        <Label>Nguồn camera (USB)</Label>
                                        <div className='flex gap-2'>
                                            <Select
                                                value={config.videoDeviceId ?? ''}
                                                onChange={(e) =>
                                                    setConfig({
                                                        ...config,
                                                        videoDeviceId: e.target.value || null,
                                                    })
                                                }
                                            >
                                                <option value=''>Mặc định</option>
                                                {videoDevices.map((d) => (
                                                    <option key={d.deviceId} value={d.deviceId}>
                                                        {d.label ||
                                                            `Camera ${d.deviceId.slice(0, 6)}`}
                                                    </option>
                                                ))}
                                            </Select>
                                            <Button variant='outline' onClick={scanVideoDevices}>
                                                Quét thiết bị
                                            </Button>
                                        </div>
                                        {/* Camera-based QR scanning removed */}

                                        <Label>Nhúng chữ vào video (USB)</Label>
                                        <div className='flex items-center gap-2'>
                                            <Button
                                                variant='outline'
                                                onClick={() =>
                                                    setConfig((c) => ({
                                                        ...c,
                                                        overlayEnabled: !c.overlayEnabled,
                                                    }))
                                                }
                                            >
                                                {config.overlayEnabled ? 'Tắt' : 'Bật'}
                                            </Button>
                                            <Input
                                                placeholder='Mã: {order} • NV: {employee}'
                                                value={config.overlayTemplate || ''}
                                                onChange={(e) =>
                                                    setConfig({
                                                        ...config,
                                                        overlayTemplate: e.target.value,
                                                    })
                                                }
                                            />
                                        </div>
                                        <div className='text-xs text-muted-foreground'>
                                            Biến: {`{order}`}, {`{employee}`}, {`{time}`},{' '}
                                            {`{elapsed}`}
                                        </div>
                                    </>
                                )}

                                {config.cameraMode === 'rtsp' && (
                                    <>
                                        <Label>RTSP URL</Label>
                                        <Input
                                            value={config.rtspUrl}
                                            onChange={(e) =>
                                                setConfig({ ...config, rtspUrl: e.target.value })
                                            }
                                            placeholder='rtsp://user:pass@host:554/...'
                                        />

                                        <Label>RTSP encode</Label>
                                        <Select
                                            value={String(!!config.rtspTranscode)}
                                            onChange={(e) =>
                                                setConfig({
                                                    ...config,
                                                    rtspTranscode: e.target.value === 'true',
                                                })
                                            }
                                        >
                                            <option value='false'>
                                                Copy (nhanh, cần H264/AAC)
                                            </option>
                                            <option value='true'>
                                                Transcode (ổn định, CPU cao)
                                            </option>
                                        </Select>
                                    </>
                                )}

                                <Label>Thư mục lưu</Label>
                                <div className='flex gap-2'>
                                    <Input
                                        readOnly
                                        value={config.saveDir ?? ''}
                                        placeholder='Chọn nơi lưu'
                                    />
                                    <Button variant='outline' onClick={chooseDir}>
                                        Chọn…
                                    </Button>
                                </div>

                                <Label>FFmpeg</Label>
                                <div className='text-sm text-muted-foreground'>
                                    {ffmpegAvailable
                                        ? 'Có sẵn'
                                        : 'Không tìm thấy (cần để MP4/RTSP)'}
                                </div>
                                <Label>Xuất 1080p (scale)</Label>
                                <Select
                                    value={String(!!config.scale1080)}
                                    onChange={(e) =>
                                        setConfig({
                                            ...config,
                                            scale1080: e.target.value === 'true',
                                        })
                                    }
                                    disabled={!ffmpegAvailable}
                                >
                                    <option value='false'>Tắt</option>
                                    <option value='true'>Bật</option>
                                </Select>
                            </div>
                            <div className='flex justify-end gap-2'>
                                <Button
                                    variant='outline'
                                    onClick={openCamera}
                                    disabled={config.cameraMode !== 'usb' || cameraReady}
                                >
                                    Mở camera
                                </Button>
                                <Button onClick={saveConfig}>Lưu thiết lập</Button>
                            </div>
                            <div className='border-t my-2' />
                            <div className='flex items-center justify-between'>
                                <div className='text-lg font-semibold'>Thống kê </div>
                                <div className='flex items-center gap-2'>
                                    <Label>Tháng</Label>
                                    <Input
                                        type='month'
                                        value={statsMonth}
                                        onChange={(e) => {
                                            const v = (e.target as HTMLInputElement).value;
                                            setStatsMonth(v);
                                            refreshMetrics(v);
                                        }}
                                    />
                                </div>
                            </div>
                            <div
                                className='text-sm'
                                dangerouslySetInnerHTML={{ __html: metricsHtml }}
                            />
                        </div>
                    </Card>
                )}
            </div>
        </div>
    );
}
