const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Prefer bundled ffmpeg (ffmpeg-static) if available; fallback to system PATH
let ffmpegPath = 'ffmpeg';
try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && typeof ffmpegStatic === 'string') {
        // When packaged with asar, ensure we point to the unpacked path
        ffmpegPath = ffmpegStatic.includes('app.asar')
            ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
            : ffmpegStatic;
    }
} catch {}

// Enable Chromium features for Shape Detection / BarcodeDetector on Windows/Linux
// Do this before app.whenReady()
try {
    // Broadly enable experimental web features and Shape Detection stack
    app.commandLine.appendSwitch('enable-experimental-web-platform-features');
    // Try both feature switch types used across Chromium/Electron versions
    app.commandLine.appendSwitch('enable-features', 'ShapeDetection,ShapeDetectionAPI,BarcodeDetection');
    app.commandLine.appendSwitch('enable-blink-features', 'ShapeDetection,BarcodeDetector');
} catch {}

// Prefer SQLite store; fallback to JSON store if sqlite3 CLI unavailable
let Store;
try {
    Store = require('./store-db');
} catch (e) {
    Store = require('./store');
}

let mainWindow;
const ffmpegProcs = new Map(); // sessionId -> child process

function createWindow() {
    mainWindow = new BrowserWindow({
        // Ensure width/height apply to the web page (content),
        // not including the window frame/menu (helps on Windows).
        useContentSize: true,
        width: 1100,
        height: 750,
        minWidth: 1000,
        minHeight: 680,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            // Enable Chromium experimental features (helps expose Shape Detection / BarcodeDetector on Windows)
            experimentalFeatures: true,
        },
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
        mainWindow.loadURL(devUrl);
    } else {
        const prodIndex = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
        if (fs.existsSync(prodIndex)) mainWindow.loadFile(prodIndex);
        else mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// Store setup
const userDataDir = app.getPath('userData');
const store = new Store({ baseDir: userDataDir });

// IPC handlers
ipcMain.handle('select-save-dir', async () => {
    try {
        if (mainWindow) {
            try {
                mainWindow.show();
                mainWindow.focus();
            } catch {}
        }
        // Use sync variant for better reliability on macOS sheets
        const filePaths = dialog.showOpenDialogSync(mainWindow, {
            title: 'Chọn thư mục lưu',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Chọn',
        });
        if (!filePaths || !filePaths.length) return null;
        return filePaths[0];
    } catch (e) {
        console.error('select-save-dir error', e);
        return null;
    }
});

ipcMain.handle('get-config', async () => {
    return store.getConfig();
});

ipcMain.handle('set-config', async (_evt, cfg) => {
    return store.setConfig(cfg);
});

ipcMain.handle('write-file', async (_evt, { filePath, data }) => {
    const buf = Buffer.from(data);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buf);
    return true;
});

ipcMain.handle('check-ffmpeg', async () => {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, ['-version']);
        let ok = false;
        proc.on('error', () => resolve({ available: false }));
        proc.stderr.on('data', () => {});
        proc.stdout.on('data', () => {
            ok = true;
        });
        proc.on('close', () => resolve({ available: ok }));
    });
});

ipcMain.handle('transcode-webm-to-mp4', async (_evt, { inputPath, outputPath }) => {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    return new Promise((resolve, reject) => {
        const args = [
            '-y',
            '-i',
            inputPath,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            outputPath,
        ];
        const proc = spawn(ffmpegPath, args);
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', (e) => reject(e));
        proc.on('close', (code) => {
            if (code === 0) resolve({ ok: true });
            else reject(new Error('ffmpeg failed: ' + stderr));
        });
    });
});

// Fire-and-forget background transcode, optionally delete input when done
ipcMain.handle('transcode-webm-to-mp4-bg', async (_evt, { inputPath, outputPath, deleteInput }) => {
    try {
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    } catch {}
    const args = [
        '-y',
        '-i',
        inputPath,
        '-c:v',
        'libx264',
        '-preset',
        'superfast',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        outputPath,
    ];
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', async (code) => {
        if (code === 0 && deleteInput) {
            try {
                await fs.promises.unlink(inputPath);
            } catch {}
        }
        if (code !== 0) {
            console.error('Background transcode failed', stderr);
        }
    });
    // Return immediately; processing continues in background
    return { started: true };
});

ipcMain.handle('record-rtsp-start', async (_evt, { sessionId, rtspUrl, outputPath, transcode }) => {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const args = transcode
        ? [
              '-rtsp_transport',
              'tcp',
              '-i',
              rtspUrl,
              '-c:v',
              'libx264',
              '-c:a',
              'aac',
              '-movflags',
              '+faststart',
              '-y',
              outputPath,
          ]
        : [
              '-rtsp_transport',
              'tcp',
              '-i',
              rtspUrl,
              '-c',
              'copy',
              '-movflags',
              '+faststart',
              '-y',
              outputPath,
          ];
    const proc = spawn(ffmpegPath, args);
    ffmpegProcs.set(sessionId, proc);
    return new Promise((resolve, reject) => {
        let started = false;
        let stderr = '';
        const timer = setTimeout(() => {
            if (!started) resolve({ started: true });
        }, 1500);
        proc.stderr.on('data', (d) => {
            stderr += d.toString();
            if (!started && /Press \[q\] to stop/.test(stderr)) {
                started = true;
                clearTimeout(timer);
                resolve({ started: true });
            }
        });
        proc.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        proc.on('close', (code) => {
            ffmpegProcs.delete(sessionId);
        });
    });
});

ipcMain.handle('record-rtsp-stop', async (_evt, { sessionId }) => {
    const proc = ffmpegProcs.get(sessionId);
    if (!proc) return { ok: false };
    // Politely end recording
    if (process.platform === 'win32') {
        proc.kill('SIGINT');
    } else {
        proc.kill('SIGTERM');
    }
    ffmpegProcs.delete(sessionId);
    return { ok: true };
});

ipcMain.handle('log-session', async (_evt, session) => {
    return store.logSession(session);
});

ipcMain.handle('get-sessions', async (_evt) => {
    return store.getSessions();
});

// Users list (from DB if available; fallback from sessions)
ipcMain.handle('get-users', async () => {
    // Preferred: DB-backed store
    if (typeof store.getUsers === 'function') {
        try {
            return store.getUsers();
        } catch (e) {
            console.error('get-users via store failed; falling back', e);
        }
    }
    // Fallback: merge users.json (maintained by add/rename/delete IPCs)
    // with any names found in historical sessions
    try {
        const fromFile = readUsersFile();
        const sessions = (await store.getSessions()) || [];
        const fromSessions = (sessions || [])
            .map((s) => (s.employee || '').trim())
            .filter(Boolean);
        const names = Array.from(new Set([...(fromFile || []), ...fromSessions]))
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'vi'));
        return names;
    } catch (e) {
        return readUsersFile();
    }
});

// Helpers for JSON fallback user list
const usersJsonPath = path.join(userDataDir, 'users.json');
function readUsersFile() {
    try {
        if (!fs.existsSync(usersJsonPath)) return [];
        const arr = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}
function writeUsersFile(arr) {
    try {
        fs.writeFileSync(usersJsonPath, JSON.stringify(arr, null, 2));
    } catch {}
}

ipcMain.handle('add-user', async (_evt, name) => {
    const n = String(name || '').trim();
    if (!n) return { ok: false };
    if (typeof store.addUser === 'function') {
        try {
            return { ok: !!store.addUser(n) };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }
    // Fallback JSON: maintain a users.json list
    const users = readUsersFile();
    if (!users.includes(n)) users.push(n);
    users.sort((a, b) => a.localeCompare(b, 'vi'));
    writeUsersFile(users);
    return { ok: true };
});

ipcMain.handle('rename-user', async (_evt, oldName, newName) => {
    const o = String(oldName || '').trim();
    const n = String(newName || '').trim();
    if (!o || !n) return { ok: false };
    if (typeof store.renameUser === 'function') {
        try {
            return { ok: !!store.renameUser(o, n) };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }
    const users = readUsersFile();
    const i = users.findIndex((x) => x === o);
    if (i >= 0) users[i] = n;
    users.sort((a, b) => a.localeCompare(b, 'vi'));
    writeUsersFile(users);
    return { ok: true };
});

ipcMain.handle('delete-user', async (_evt, name) => {
    const n = String(name || '').trim();
    if (!n) return { ok: false };
    if (typeof store.deleteUser === 'function') {
        try {
            return { ok: !!store.deleteUser(n) };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }
    const users = readUsersFile();
    const next = users.filter((x) => x !== n);
    writeUsersFile(next);
    return { ok: true };
});
