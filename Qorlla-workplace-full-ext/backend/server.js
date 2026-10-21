const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function load(name) {
  const file = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(file)) return name === 'users' ? [] : {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

// Simple in-memory sessions (resets on restart) + lockout
const sessions = new Map();
const lockouts = new Map();
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function hash(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function getUser(req) {
  const sid = req.headers['x-session'] || req.query.session;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) return null;
  return s.user;
}

// ---------- AUTH ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const users = load('users');
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'email exists' });
  const user = { id: uuidv4(), name, email, passwordHash: hash(password), createdAt: new Date().toISOString() };
  users.push(user);
  save('users', users);
  res.json({ ok: true, user: { id: user.id, name, email } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const key = email || 'unknown';
  const lock = lockouts.get(key);
  if (lock && lock.until > Date.now()) {
    return res.status(429).json({ error: 'locked out', until: lock.until });
  }
  const users = load('users');
  const user = users.find(u => u.email === email && u.passwordHash === hash(password));
  if (!user) {
    const attempts = (lockouts.get(key)?.attempts || 0) + 1;
    if (attempts >= LOCKOUT_THRESHOLD) {
      lockouts.set(key, { attempts, until: Date.now() + LOCKOUT_MS });
    } else {
      lockouts.set(key, { attempts, until: 0 });
    }
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
  res.json(user);
});

// ---------- Per-user helpers ----------
function userKey(user, name) {
  return user ? `${name}_${user.id}` : name;
}

// ---------- MAIL (per user) ----------
app.get('/api/mail', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  res.json(load(userKey(user, 'mail')) || []);
});
app.post('/api/mail', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  const items = load(userKey(user, 'mail')) || [];
  const item = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString(), read: false };
  items.unshift(item);
  save(userKey(user, 'mail'), items);
  res.json(item);
});
app.patch('/api/mail/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  let items = load(userKey(user, 'mail')) || [];
  items = items.map(i => i.id === req.params.id ? { ...i, ...req.body } : i);
  save(userKey(user, 'mail'), items);
  res.json({ ok: true });
});
app.delete('/api/mail/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  save(userKey(user, 'mail'), (load(userKey(user, 'mail')) || []).filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- NOTES (per user) ----------
app.get('/api/notes', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  res.json(load(userKey(user, 'notes')) || []);
});
app.post('/api/notes', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  const items = load(userKey(user, 'notes')) || [];
  const item = { id: uuidv4(), ...req.body, updatedAt: new Date().toISOString() };
  items.unshift(item);
  save(userKey(user, 'notes'), items);
  res.json(item);
});
app.put('/api/notes/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  let items = load(userKey(user, 'notes')) || [];
  items = items.map(i => i.id === req.params.id ? { ...i, ...req.body, updatedAt: new Date().toISOString() } : i);
  save(userKey(user, 'notes'), items);
  res.json({ ok: true });
});
app.delete('/api/notes/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  save(userKey(user, 'notes'), (load(userKey(user, 'notes')) || []).filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- CALENDAR (per user) ----------
app.get('/api/calendar', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  res.json(load(userKey(user, 'calendar')) || []);
});
app.post('/api/calendar', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  const items = load(userKey(user, 'calendar')) || [];
  const item = { id: uuidv4(), ...req.body };
  items.push(item);
  save(userKey(user, 'calendar'), items);
  res.json(item);
});
app.delete('/api/calendar/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  save(userKey(user, 'calendar'), (load(userKey(user, 'calendar')) || []).filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- SCHEDULE (per user) ----------
app.get('/api/schedule', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  res.json(load(userKey(user, 'schedule')) || []);
});
app.post('/api/schedule', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  const items = load(userKey(user, 'schedule')) || [];
  const item = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString() };
  items.push(item);
  save(userKey(user, 'schedule'), items);
  res.json(item);
});
app.delete('/api/schedule/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  save(userKey(user, 'schedule'), (load(userKey(user, 'schedule')) || []).filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- WHITEBOARD (per user) ----------
app.get('/api/whiteboard', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  res.json(load(userKey(user, 'whiteboard')) || []);
});
app.post('/api/whiteboard', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  const items = load(userKey(user, 'whiteboard')) || [];
  const item = { id: uuidv4(), ...req.body, updatedAt: new Date().toISOString() };
  items.unshift(item);
  save(userKey(user, 'whiteboard'), items);
  res.json(item);
});
app.put('/api/whiteboard/:id', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  let items = load(userKey(user, 'whiteboard')) || [];
  items = items.map(i => i.id === req.params.id ? { ...i, ...req.body, updatedAt: new Date().toISOString() } : i);
  save(userKey(user, 'whiteboard'), items);
  res.json({ ok: true });
});

// ---------- CHAT (polling, last 500, public meeting chats + #general) ----------
app.get('/api/chat/:room', (req, res) => {
  const room = req.params.room;
  const all = load('chat') || {};
  const msgs = (all[room] || []).slice(-500);
  res.json(msgs);
});
app.post('/api/chat/:room', (req, res) => {
  const user = getUser(req);
  const room = req.params.room;
  const all = load('chat') || {};
  if (!all[room]) all[room] = [];
  const msg = {
    id: uuidv4(),
    text: req.body.text,
    from: user ? user.name : 'Anonymous',
    userId: user ? user.id : null,
    ts: new Date().toISOString()
  };
  all[room].push(msg);
  if (all[room].length > 500) all[room] = all[room].slice(-500);
  save('chat', all);
  res.json(msg);
});

// Public rooms: meeting chats and #general
app.get('/api/rooms', (req, res) => {
  res.json([
    { id: 'general', name: '#general', public: true },
    { id: 'quantum', name: 'H-Quantum-CLASSICAL Meeting', public: true },
    { id: 'cda', name: 'CDA Research Meeting & Update', public: true }
  ]);
});

// ---------- APPS (only two) ----------
app.get('/api/apps', (req, res) => {
  res.json([
    { id: 'whiteboard', name: 'Whiteboard' },
    { id: 'notes', name: 'Notes' }
  ]);
});

app.listen(3000, () => console.log('Backend running on http://localhost:3000'));
