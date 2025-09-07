type OverlayOpts = {
    template: string;
    vars?: Record<string, string>;
    startMs?: number; // used for {elapsed}
};

export class UsbRecorder {
    private videoEl: HTMLVideoElement;
    private stream: MediaStream | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private mime: string | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private canvasCtx: CanvasRenderingContext2D | null = null;
    private rafId: number | null = null;
    private canvasStream: MediaStream | null = null;
    private compositeStream: MediaStream | null = null;
    private overlayOpts: OverlayOpts | null = null;

    constructor(videoEl: HTMLVideoElement) {
        this.videoEl = videoEl;
    }

    async init(deviceId?: string) {
        const video: MediaTrackConstraints | boolean = deviceId
            ? { deviceId: { exact: deviceId } }
            : true;
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
        this.videoEl.srcObject = this.stream as any;
        // Prefer MP4 if reliably supported to avoid slow post-stop transcode.
        // Fall back to WebM where MediaRecorder is more reliable.
        const candidates = [
            'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
            'video/mp4',
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
        ];
        this.mime =
            candidates.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t)) || '';
        if (!this.mime) this.mime = '';
    }

    start(overlay?: OverlayOpts) {
        if (!this.stream) throw new Error('stream not ready');
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') return;
        this.chunks = [];

        let recordStream: MediaStream = this.stream!;

        // If overlay text requested, render video into a canvas and capture that stream
        if (overlay) {
            this.overlayOpts = overlay;
            if (!this.canvas) this.canvas = document.createElement('canvas');
            const cvs = this.canvas;
            const fmtElapsed = (ms: number) => {
                const totalSec = Math.max(0, Math.floor(ms / 1000));
                const hh = Math.floor(totalSec / 3600);
                const mm = Math.floor((totalSec % 3600) / 60);
                const ss = totalSec % 60;
                if (hh > 0) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
                return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
            };
            const buildText = () => {
                const tmpl = this.overlayOpts?.template || '';
                const base = this.overlayOpts?.vars || {};
                const nowStr = new Date().toLocaleString();
                const start = this.overlayOpts?.startMs || Date.now();
                const elapsed = fmtElapsed(Date.now() - start);
                let txt = tmpl;
                const pairs: Record<string, string> = {
                    time: nowStr,
                    elapsed,
                    ...base,
                };
                for (const [k, v] of Object.entries(pairs)) {
                    txt = txt.replace(new RegExp(`\\{${k}\\}`, 'g'), v ?? '');
                }
                return txt;
            };
            const setupCanvas = () => {
                const vw = this.videoEl.videoWidth;
                const vh = this.videoEl.videoHeight;
                if (vw > 0 && vh > 0) {
                    if (cvs!.width !== vw || cvs!.height !== vh) {
                        cvs!.width = vw;
                        cvs!.height = vh;
                        this.canvasCtx = cvs!.getContext('2d');
                    }
                }
            };
            setupCanvas();
            const draw = () => {
                try {
                    setupCanvas();
                    const ctx = this.canvasCtx;
                    if (ctx && this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0) {
                        ctx.drawImage(this.videoEl, 0, 0, cvs!.width, cvs!.height);
                        // Draw overlay background and text
                        const pad = Math.max(8, Math.floor(cvs!.height * 0.02));
                        const fontSize = Math.max(16, Math.floor(cvs!.height * 0.04));
                        ctx.font = `${fontSize}px sans-serif`;
                        ctx.textBaseline = 'top';
                        const text = buildText();
                        const metrics = ctx.measureText(text);
                        const tw = Math.ceil(metrics.width);
                        const th = Math.ceil(fontSize * 1.4);
                        const x = pad;
                        const y = pad;
                        ctx.fillStyle = 'rgba(0,0,0,0.5)';
                        ctx.fillRect(x - pad * 0.5, y - pad * 0.5, tw + pad, th + pad);
                        ctx.fillStyle = '#fff';
                        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                        ctx.lineWidth = Math.max(2, Math.floor(fontSize * 0.08));
                        // Slight shadow for readability
                        ctx.shadowColor = 'rgba(0,0,0,0.6)';
                        ctx.shadowBlur = Math.max(2, Math.floor(fontSize * 0.15));
                        ctx.shadowOffsetX = 1;
                        ctx.shadowOffsetY = 1;
                        ctx.fillText(text, x, y);
                        // reset shadow
                        ctx.shadowColor = 'transparent';
                    }
                } finally {
                    this.rafId = requestAnimationFrame(draw);
                }
            };
            // Kick the draw loop
            this.rafId = requestAnimationFrame(draw);

            const vTrack = cvs!.captureStream().getVideoTracks()[0];
            this.canvasStream = new MediaStream([vTrack]);
            const tracks: MediaStreamTrack[] = [vTrack];
            // Add audio from original stream
            this.stream.getAudioTracks().forEach((t) => tracks.push(t));
            this.compositeStream = new MediaStream(tracks);
            recordStream = this.compositeStream;
        }

        this.mediaRecorder = new MediaRecorder(recordStream, this.mime ? { mimeType: this.mime } : undefined);
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        this.mediaRecorder.start();
    }

    async stop() {
        if (!this.mediaRecorder) return null;
        const mr = this.mediaRecorder;
        if (mr.state !== 'inactive') {
            await new Promise<void>((resolve) => {
                const handleStop = () => {
                    mr.removeEventListener('stop', handleStop);
                    resolve();
                };
                mr.addEventListener('stop', handleStop);
                try {
                    mr.stop();
                } catch {
                    // if stop throws because already inactive, resolve immediately
                    mr.removeEventListener('stop', handleStop);
                    resolve();
                }
            });
        }
        const blob = new Blob(this.chunks, { type: this.mime || 'video/webm' });
        // Stop overlay drawing/streams if used
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        try {
            this.canvasStream?.getTracks().forEach((t) => t.stop());
            this.compositeStream?.getTracks().forEach((t) => t.stop());
            this.canvasStream = null;
            this.compositeStream = null;
        } catch {}
        this.overlayOpts = null;
        return blob;
    }

    async dispose() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive')
            this.mediaRecorder.stop();
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        if (this.rafId) cancelAnimationFrame(this.rafId);
        try {
            this.canvasStream?.getTracks().forEach((t) => t.stop());
            this.compositeStream?.getTracks().forEach((t) => t.stop());
        } catch {}
    }
}
