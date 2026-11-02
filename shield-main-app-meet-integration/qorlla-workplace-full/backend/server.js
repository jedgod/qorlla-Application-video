const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function load(name) {
  const file = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

// ---------- MAIL ----------
app.get('/api/mail', (req, res) => res.json(load('mail')));
app.post('/api/mail', (req, res) => {
  const items = load('mail');
  const item = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString(), read: false };
  items.unshift(item);
  save('mail', items);
  res.json(item);
});
app.patch('/api/mail/:id', (req, res) => {
  let items = load('mail');
  items = items.map(i => i.id === req.params.id ? { ...i, ...req.body } : i);
  save('mail', items);
  res.json({ ok: true });
});
app.delete('/api/mail/:id', (req, res) => {
  save('mail', load('mail').filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- WHITEBOARD ----------
app.get('/api/whiteboard', (req, res) => res.json(load('whiteboard')));
app.post('/api/whiteboard', (req, res) => {
  const items = load('whiteboard');
  const item = { id: uuidv4(), ...req.body, updatedAt: new Date().toISOString() };
  items.unshift(item);
  save('whiteboard', items);
  res.json(item);
});
app.put('/api/whiteboard/:id', (req, res) => {
  let items = load('whiteboard');
  items = items.map(i => i.id === req.params.id ? { ...i, ...req.body, updatedAt: new Date().toISOString() } : i);
  save('whiteboard', items);
  res.json({ ok: true });
});

// ---------- CALENDAR ----------
app.get('/api/calendar', (req, res) => res.json(load('calendar')));
app.post('/api/calendar', (req, res) => {
  const items = load('calendar');
  const item = { id: uuidv4(), ...req.body };
  items.push(item);
  save('calendar', items);
  res.json(item);
});
app.delete('/api/calendar/:id', (req, res) => {
  save('calendar', load('calendar').filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- SCHEDULE (meetings) ----------
app.get('/api/schedule', (req, res) => res.json(load('schedule')));
app.post('/api/schedule', (req, res) => {
  const items = load('schedule');
  const item = { id: uuidv4(), ...req.body, createdAt: new Date().toISOString() };
  items.push(item);
  save('schedule', items);
  res.json(item);
});
app.delete('/api/schedule/:id', (req, res) => {
  save('schedule', load('schedule').filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- NOTES ----------
app.get('/api/notes', (req, res) => res.json(load('notes')));
app.post('/api/notes', (req, res) => {
  const items = load('notes');
  const item = { id: uuidv4(), ...req.body, updatedAt: new Date().toISOString() };
  items.unshift(item);
  save('notes', items);
  res.json(item);
});
app.put('/api/notes/:id', (req, res) => {
  let items = load('notes');
  items = items.map(i => i.id === req.params.id ? { ...i, ...req.body, updatedAt: new Date().toISOString() } : i);
  save('notes', items);
  res.json({ ok: true });
});
app.delete('/api/notes/:id', (req, res) => {
  save('notes', load('notes').filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

app.listen(3000, () => console.log('Backend running on http://localhost:3000'));
