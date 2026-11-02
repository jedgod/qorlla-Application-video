// Normalizes MAIN's per-user JSON schedules (DATA_DIR/workplace/schedule.<userId>.json) into one array
// for export-legacy.mjs. Read-only. Uses store.js so encrypted data files (ENCRYPT_KEY) are handled.
// Usage: node meet-sync/scripts/collect-main-schedules.cjs [dataDir] > schedules.json
const fs = require('fs');
const path = require('path');
const store = require('../../store');
const dataDir = process.argv[2] || process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const users = store.readJson(path.join(dataDir, 'auth', 'users.json'), []);
const names = new Map(users.map((u) => [u.id, u.displayName || u.username]));
const out = [];
for (const f of fs.readdirSync(path.join(dataDir, 'workplace'))) {
    const m = /^schedule\.(u_[\w-]+)\.json$/.exec(f);
    if (!m) continue;
    for (const s of store.readJson(path.join(dataDir, 'workplace', f), [])) {
        const when = new Date(`${s.date}T${s.time}:00`);
        out.push({
            id: s.id, meetingId: s.meetingId, title: s.title,
            ownerName: names.get(s.hostId || m[1]) || '',
            scheduledAt: isNaN(when) ? null : when.toISOString()
        });
    }
}
process.stdout.write(JSON.stringify(out, null, 1));
