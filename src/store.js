const path = require('path');
const fs = require('fs');

class Store {
    constructor({ baseDir }) {
        this.baseDir = baseDir;
        this.configPath = path.join(baseDir, 'config.json');
        this.sessionsPath = path.join(baseDir, 'sessions.json');
        this._ensure();
    }

    _ensure() {
        if (!fs.existsSync(this.configPath)) {
            fs.writeFileSync(
                this.configPath,
                JSON.stringify(
                    {
                        saveDir: null,
                        cameraMode: 'usb', // 'usb' | 'rtsp'
                        rtspUrl: '',
                        employeeName: '',
                        rtspTranscode: false,
                        scale1080: false,
                        videoDeviceId: null,
                        videoDeviceLabel: null,
                    },
                    null,
                    2
                )
            );
        }
        if (!fs.existsSync(this.sessionsPath)) {
            fs.writeFileSync(this.sessionsPath, JSON.stringify([], null, 2));
        }
    }

    getConfig() {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    }

    setConfig(cfg) {
        fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
        return cfg;
    }

    getSessions() {
        try {
            return JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'));
        } catch (e) {
            return [];
        }
    }

    logSession(session) {
        const list = this.getSessions();
        list.push(session);
        fs.writeFileSync(this.sessionsPath, JSON.stringify(list, null, 2));
        return true;
    }
}

module.exports = Store;
