const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');

contextBridge.exposeInMainWorld('api', {
    selectSaveDir: () => ipcRenderer.invoke('select-save-dir'),
    getConfig: () => ipcRenderer.invoke('get-config'),
    setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
    writeFile: (filePath, arrayBuffer) =>
        ipcRenderer.invoke('write-file', { filePath, data: Buffer.from(arrayBuffer) }),
    checkFFmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
    transcodeWebmToMp4: (inputPath, outputPath) =>
        ipcRenderer.invoke('transcode-webm-to-mp4', { inputPath, outputPath }),
    transcodeWebmToMp4Bg: (inputPath, outputPath, deleteInput = true) =>
        ipcRenderer.invoke('transcode-webm-to-mp4-bg', { inputPath, outputPath, deleteInput }),
    recordRtspStart: (sessionId, rtspUrl, outputPath, transcode) =>
        ipcRenderer.invoke('record-rtsp-start', { sessionId, rtspUrl, outputPath, transcode }),
    recordRtspStop: (sessionId) => ipcRenderer.invoke('record-rtsp-stop', { sessionId }),
    logSession: (s) => ipcRenderer.invoke('log-session', s),
    getSessions: () => ipcRenderer.invoke('get-sessions'),
    getUsers: () => ipcRenderer.invoke('get-users'),
    addUser: (name) => ipcRenderer.invoke('add-user', name),
    renameUser: (oldName, newName) => ipcRenderer.invoke('rename-user', oldName, newName),
    deleteUser: (name) => ipcRenderer.invoke('delete-user', name),
    pathJoin: (...parts) => path.join(...parts),
    tmpDir: () => os.tmpdir(),
});
