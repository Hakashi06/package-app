const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function hasSqlite3() {
    try {
        const r = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
        return r.status === 0;
    } catch (e) {
        return false;
    }
}

function esc(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    // escape single quotes by doubling them
    return "'" + String(v).replace(/'/g, "''") + "'";
}

function run(dbPath, sql) {
    const r = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(r.stderr || 'sqlite3 error');
    }
    return r.stdout;
}

function queryJson(dbPath, jsonSql) {
    const out = run(dbPath, jsonSql).trim();
    if (!out) return null;
    try {
        return JSON.parse(out);
    } catch (e) {
        // Some sqlite3 builds print a trailing newline or warnings; try last JSON-looking line
        const lines = out.split(/\n+/).reverse();
        for (const line of lines) {
            const s = line.trim();
            if (s.startsWith('[') || s.startsWith('{') || s === 'null') {
                try {
                    return JSON.parse(s);
                } catch {}
            }
        }
        throw e;
    }
}

class SqliteStore {
    constructor({ baseDir }) {
        this.baseDir = baseDir;
        this.dbPath = path.join(baseDir, 'app.sqlite3');
        this.useSqlite = hasSqlite3();
        if (!this.useSqlite) {
            // Fallback to JSON store
            const JsonStore = require('./store');
            return new JsonStore({ baseDir });
        }
        fs.mkdirSync(baseDir, { recursive: true });
        this._init();
    }

    _init() {
        // Create tables
        const sql = `
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS app_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_name TEXT,
            order_code TEXT,
            start TEXT,
            end TEXT,
            duration_ms INTEGER,
            file_path TEXT
        );
        `;
        run(this.dbPath, sql);

        // Ensure default config row
        const cfg = queryJson(
            this.dbPath,
            "SELECT COALESCE((SELECT data FROM app_config WHERE id=1), 'null') AS json;"
        );
        if (!cfg) {
            const defaultCfg = {
                saveDir: null,
                cameraMode: 'usb',
                rtspUrl: '',
                employeeName: '',
                rtspTranscode: false,
                videoDeviceId: null,
                videoDeviceLabel: null,
            };
            run(
                this.dbPath,
                `INSERT OR REPLACE INTO app_config(id,data) VALUES(1, ${esc(
                    JSON.stringify(defaultCfg)
                )});`
            );
        }
    }

    getConfig() {
        const row = queryJson(this.dbPath, 'SELECT json(data) FROM app_config WHERE id=1;');
        // queryJson returns parsed JSON, not array
        return row;
    }

    setConfig(cfg) {
        // If employeeName present, ensure in users table
        const name = (cfg.employeeName || '').trim();
        if (name) {
            try {
                run(this.dbPath, `INSERT OR IGNORE INTO users(name) VALUES(${esc(name)});`);
            } catch {}
        }
        run(this.dbPath, `UPDATE app_config SET data=${esc(JSON.stringify(cfg))} WHERE id=1;`);
        return cfg;
    }

    getSessions() {
        const arr = queryJson(
            this.dbPath,
            "SELECT COALESCE(json_group_array(json_object('employee', employee_name, 'order', order_code, 'start', start, 'end', end, 'durationMs', duration_ms, 'filePath', file_path)), '[]') FROM sessions;"
        );
        return Array.isArray(arr) ? arr : [];
    }

    logSession(session) {
        const name = (session.employee || '').trim();
        if (name) run(this.dbPath, `INSERT OR IGNORE INTO users(name) VALUES(${esc(name)});`);
        const sql = `INSERT INTO sessions(employee_name, order_code, start, end, duration_ms, file_path)
                     VALUES(${esc(session.employee)}, ${esc(session.order)}, ${esc(
            session.start
        )}, ${esc(session.end)}, ${esc(session.durationMs)}, ${esc(session.filePath)});`;
        run(this.dbPath, sql);
        return true;
    }

    getUsers() {
        const arr = queryJson(
            this.dbPath,
            "SELECT COALESCE((SELECT json_group_array(name) FROM (SELECT name FROM users ORDER BY name COLLATE NOCASE)), '[]');"
        );
        return Array.isArray(arr) ? arr : [];
    }

    addUser(name) {
        const n = String(name || '').trim();
        if (!n) return false;
        run(this.dbPath, `INSERT OR IGNORE INTO users(name) VALUES(${esc(n)});`);
        return true;
    }

    renameUser(oldName, newName) {
        const o = String(oldName || '').trim();
        const n = String(newName || '').trim();
        if (!o || !n) return false;
        run(this.dbPath, `UPDATE OR IGNORE users SET name=${esc(n)} WHERE name=${esc(o)};`);
        // Also update sessions for consistency
        run(
            this.dbPath,
            `UPDATE sessions SET employee_name=${esc(n)} WHERE employee_name=${esc(o)};`
        );
        return true;
    }

    deleteUser(name) {
        const n = String(name || '').trim();
        if (!n) return false;
        run(this.dbPath, `DELETE FROM users WHERE name=${esc(n)};`);
        // Keep sessions as historical records
        return true;
    }
}

module.exports = SqliteStore;
