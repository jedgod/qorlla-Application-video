require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Trust proxy so req.ip reflects real client when behind nginx
app.set('trust proxy', true);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

const ENCRYPT_KEY = process.env.ENCRYPT_KEY ? Buffer.from(process.env.ENCRYPT_KEY, 'hex') : null;
const ALGO = 'aes-256-gcm';
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:8080';
const SMTP_URL = process.env.SMTP_URL;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@localhost';
const MSG_CAP = 500;

let transporter = null;
if (SMTP_URL) transporter = nodemailer.createTransport(SMTP_URL);

function encrypt(text) {
  if (!ENCRYPT_KEY) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ENCRYPT_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') });
}
function decrypt(payload) {
  if (!ENCRYPT_KEY || typeof payload !== 'string' || !payload.startsWith('{')) return payload;
  try {
    const { iv, tag, data } = JSON.parse(payload);
    const decipher = crypto.createDecipheriv(ALGO, ENCRYPT_KEY, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
  } catch { return payload; }
}

function load(name) {
  const file = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(file)) return name === 'users' ? [] : (name === 'chat' ? {} : []);
  const raw = fs.readFileSync(file, 'utf8');
  const text = ENCRYPT_KEY ? decrypt(raw) : raw;
  try { return JSON.parse(text); } catch { return name === 'users' ? [] : (name === 'chat' ? {} : []); }
}
function save(name, data) {
  const text = JSON.stringify(data, null, 2);
  const out = ENCRYPT_KEY ? encrypt(text) : text;
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), out);
}

const sessions = new Map();
const lockouts = new Map(); // key = action:ip  — resets on restart
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const resetTokens = new Map();

function hash(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function randomCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }
function clientIp(req) { return req.ip || req.connection.remoteAddress || 'unknown'; }

function getUser(req) {
  const sid = req.headers['x-session'] || req.query.session;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) return null;
  return s.user;
}

async function sendMail(to, subject, html) {
  if (!transporter) { console.log('[mail skipped]', to, subject); return { skipped: true }; }
  await transporter.sendMail({ from: SMTP_FROM, to, subject, html });
  return { sent: true };
}

// ---------- AUTH ----------
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const users = load('users');
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'email exists' });
  const user = { id: uuidv4(), name, email, passwordHash: hash(password), emailVerified: false, recoveryCodes: [], createdAt: new Date().toISOString() };
  users.push(user);
  save('users', users);
  const token = uuidv4();
  resetTokens.set('verify:' + email, { token, expires: Date.now() + 24 * 3600 * 1000 });
  const link = `${PUBLIC_URL}/?verify=${token}&email=${encodeURIComponent(email)}`;
  await sendMail(email, 'Verify your email', `<p>Click to verify: <a href="${link}">${link}</a></p>`);
  res.json({ ok: true, user: { id: user.id, name, email } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const key = 'login:' + clientIp(req);
  const lock = lockouts.get(key);
  if (lock && lock.until > Date.now()) return res.status(429).json({ error: 'locked out', until: lock.until });
  const users = load('users');
  const user = users.find(u => u.email === email && u.passwordHash === hash(password));
  if (!user) {
    const attempts = (lockouts.get(key)?.attempts || 0) + 1;
    lockouts.set(key, { attempts, until: attempts >= LOCKOUT_THRESHOLD ? Date.now() + LOCKOUT_MS : 0 });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  lockouts.delete(key);
  const sid = uuidv4();
  sessions.set(sid, { user: { id: user.id, name: user.name, email: user.email }, expires: Date.now() + 7 * 24 * 3600 * 1000 });
  res.json({ session: sid, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = req.headers['x-session'];
  if (sid) sessions.delete(sid);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  const full = load('users').find(u => u.id === user.id);
  res.json({ ...user, emailVerified: full?.emailVerified, hasRecoveryCodes: (full?.recoveryCodes || []).length > 0 });
});

app.post('/api/auth/reset-request', async (req, res) => {
  const { email } = req.body;
  const key = 'reset:' + clientIp(req);
  const lock = lockouts.get(key);
  if (lock && lock.until > Date.now()) return res.status(429).json({ error: 'locked out' });
  const users = load('users');
  const user = users.find(u => u.email === email);
  if (user) {
    const token = uuidv4();
    resetTokens.set('reset:' + email, { token, expires: Date.now() + 3600 * 1000 });
    const link = `${PUBLIC_URL}/?reset=${token}&email=${encodeURIComponent(email)}`;
    await sendMail(email, 'Password reset', `<p>Reset link (valid 1h): <a href="${link}">${link}</a></p>`);
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset-confirm', (req, res) => {
  const { email, token, newPassword } = req.body;
  const stored = resetTokens.get('reset:' + email);
  if (!stored || stored.token !== token || stored.expires < Date.now()) return res.status(400).json({ error: 'invalid or expired token' });
  const users = load('users');
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'user not found' });
  user.passwordHash = hash(newPassword);
  save('users', users);
  resetTokens.delete('reset:' + email);
  res.json({ ok: true });
});

app.post('/api/auth/recovery/generate', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  const codes = Array.from({ length: 8 }, randomCode);
  const users = load('users');
  const u = users.find(x => x.id === user.id);
  if (u) { u.recoveryCodes = codes.map(c => hash(c)); save('users', users); }
  res.json({ codes });
});

app.post('/api/auth/recovery/use', (req, res) => {
  const { email, code, newPassword } = req.body;
  const key = 'recovery:' + clientIp(req);
  const lock = lockouts.get(key);
  if (lock && lock.until > Date.now()) return res.status(429).json({ error: 'locked out' });
  const users = load('users');
  const user = users.find(u => u.email === email);
  if (!user || !(user.recoveryCodes || []).includes(hash(code))) {
    const attempts = (lockouts.get(key)?.attempts || 0) + 1;
    lockouts.set(key, { attempts, until: attempts >= LOCKOUT_THRESHOLD ? Date.now() + LOCKOUT_MS : 0 });
    return res.status(401).json({ error: 'invalid recovery code' });
  }
  user.passwordHash = hash(newPassword);
  user.recoveryCodes = user.recoveryCodes.filter(h => h !== hash(code));
  save('users', users);
  lockouts.delete(key);
  res.json({ ok: true });
});

app.post('/api/auth/verify', (req, res) => {
  const { email, token } = req.body;
  const stored = resetTokens.get('verify:' + email);
  if (!stored || stored.token !== token || stored.expires < Date.now()) return res.status(400).json({ error: 'invalid or expired token' });
  const users = load('users');
  const user = users.find(u => u.email === email);
  if (user) { user.emailVerified = true; save('users', users); }
  resetTokens.delete('verify:' + email);
  res.json({ ok: true });
});

function userKey(user, name) { return user ? `${name}_${user.id}` : name; }

// Mail, Notes, Calendar, Schedule, Whiteboard — same as before (omitted for brevity in this paste; full versions remain)
app.get('/api/mail', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); res.json(load(userKey(u,'mail'))||[]); });
app.post('/api/mail', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); const items = load(userKey(u,'mail'))||[]; const item = {id:uuidv4(),...req.body,createdAt:new Date().toISOString(),read:false,internal:true}; items.unshift(item); save(userKey(u,'mail'),items); res.json({...item,note:'internal only'}); });
app.get('/api/notes', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); res.json(load(userKey(u,'notes'))||[]); });
app.post('/api/notes', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); const items = load(userKey(u,'notes'))||[]; const item = {id:uuidv4(),...req.body,updatedAt:new Date().toISOString()}; items.unshift(item); save(userKey(u,'notes'),items); res.json(item); });
app.get('/api/calendar', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); res.json(load(userKey(u,'calendar'))||[]); });
app.post('/api/calendar', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); const items = load(userKey(u,'calendar'))||[]; const item = {id:uuidv4(),...req.body}; items.push(item); save(userKey(u,'calendar'),items); res.json(item); });
app.get('/api/schedule', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); res.json(load(userKey(u,'schedule'))||[]); });
app.post('/api/schedule', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); const items = load(userKey(u,'schedule'))||[]; const item = {id:uuidv4(),...req.body,createdAt:new Date().toISOString()}; items.push(item); save(userKey(u,'schedule'),items); res.json(item); });
app.get('/api/whiteboard', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); res.json(load(userKey(u,'whiteboard'))||[]); });
app.post('/api/whiteboard', (req, res) => { const u = getUser(req); if (!u) return res.status(401).json({error:'auth'}); const items = load(userKey(u,'whiteboard'))||[]; const item = {id:uuidv4(),...req.body,updatedAt:new Date().toISOString()}; items.unshift(item); save(userKey(u,'whiteboard'),items); res.json(item); });

// ---------- CHAT with archive ----------
function archiveExcess(room, msgs) {
  if (msgs.length <= MSG_CAP) return msgs;
  const excess = msgs.slice(0, msgs.length - MSG_CAP);
  const archiveFile = path.join(ARCHIVE_DIR, room + '.jsonl');
  const lines = excess.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.appendFileSync(archiveFile, lines);
  return msgs.slice(-MSG_CAP);
}

app.get('/api/chat/:room', (req, res) => {
  const all = load('chat') || {};
  res.json((all[req.params.room] || []).slice(-MSG_CAP));
});
app.get('/api/chat/:room/archive', (req, res) => {
  const file = path.join(ARCHIVE_DIR, req.params.room + '.jsonl');
  if (!fs.existsSync(file)) return res.json([]);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const msgs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(msgs);
});
app.post('/api/chat/:room', (req, res) => {
  const user = getUser(req);
  const room = req.params.room;
  const all = load('chat') || {};
  if (!all[room]) all[room] = [];
  const msg = { id: uuidv4(), text: req.body.text, from: user ? user.name : 'Anonymous', userId: user ? user.id : null, ts: new Date().toISOString() };
  all[room].push(msg);
  all[room] = archiveExcess(room, all[room]);
  save('chat', all);
  // Broadcast via WebSocket
  broadcast(room, msg);
  res.json(msg);
});

app.get('/api/rooms', (req, res) => {
  res.json([
    { id: 'general', name: '#general', public: true },
    { id: 'quantum', name: 'H-Quantum-CLASSICAL Meeting', public: true },
    { id: 'cda', name: 'CDA Research Meeting & Update', public: true }
  ]);
});
app.get('/api/apps', (req, res) => res.json([{ id: 'whiteboard', name: 'Whiteboard' }, { id: 'notes', name: 'Notes' }]));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const roomClients = new Map(); // room -> Set<ws>

function broadcast(room, msg) {
  const set = roomClients.get(room);
  if (!set) return;
  const payload = JSON.stringify({ type: 'message', room, msg });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'join' && data.room) {
        if (!roomClients.has(data.room)) roomClients.set(data.room, new Set());
        roomClients.get(data.room).add(ws);
        ws.room = data.room;
      }
    } catch {}
  });
  ws.on('close', () => {
    if (ws.room && roomClients.has(ws.room)) roomClients.get(ws.room).delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend + WS on http://localhost:${PORT}`));
