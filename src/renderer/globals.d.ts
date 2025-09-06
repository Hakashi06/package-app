export {};

declare global {
    interface Window {
        api: {
            selectSaveDir: () => Promise<string | null>;
            getConfig: () => Promise<any>;
            setConfig: (cfg: any) => Promise<any>;
            writeFile: (filePath: string, data: ArrayBuffer) => Promise<boolean>;
            checkFFmpeg: () => Promise<{ available: boolean }>;
            transcodeWebmToMp4: (inputPath: string, outputPath: string) => Promise<any>;
            recordRtspStart: (
                sessionId: string,
                rtspUrl: string,
                outputPath: string,
                transcode: boolean
            ) => Promise<any>;
            recordRtspStop: (sessionId: string) => Promise<any>;
            logSession: (s: any) => Promise<any>;
            getSessions: () => Promise<any[]>;
            getUsers: () => Promise<string[]>;
            addUser: (name: string) => Promise<{ ok: boolean; error?: string }>;
            renameUser: (
                oldName: string,
                newName: string
            ) => Promise<{ ok: boolean; error?: string }>;
            deleteUser: (name: string) => Promise<{ ok: boolean; error?: string }>;
            pathJoin: (...parts: string[]) => string;
            tmpDir: () => string;
        };
    }
    // Optional BarcodeDetector (Chromium)
    var BarcodeDetector: {
        new (options?: { formats?: string[] }): BarcodeDetector;
        getSupportedFormats?: () => Promise<string[]>;
    } | undefined;
}

interface BarcodeDetector {
    detect(source: CanvasImageSource): Promise<Array<{ rawValue: string; format: string }>>;
}

// Minimal typing for jsQR fallback
declare module 'jsqr' {
    export interface JsQrResultPoint { x: number; y: number }
    export interface JsQrResult {
        data: string;
        binaryData: Uint8Array;
        location: {
            topLeftCorner: JsQrResultPoint;
            topRightCorner: JsQrResultPoint;
            bottomLeftCorner: JsQrResultPoint;
            bottomRightCorner: JsQrResultPoint;
        };
    }
    export default function jsQR(
        data: Uint8ClampedArray,
        width: number,
        height: number,
        options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }
    ): JsQrResult | null;
}
