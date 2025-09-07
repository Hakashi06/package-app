export class UsbRecorder {
    private videoEl: HTMLVideoElement;
    private stream: MediaStream | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private mime: string | null = null;

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

    start() {
        if (!this.stream) throw new Error('stream not ready');
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') return;
        this.chunks = [];
        this.mediaRecorder = new MediaRecorder(
            this.stream!,
            this.mime ? { mimeType: this.mime } : undefined
        );
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
        return new Blob(this.chunks, { type: this.mime || 'video/webm' });
    }

    async dispose() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive')
            this.mediaRecorder.stop();
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    }
}
