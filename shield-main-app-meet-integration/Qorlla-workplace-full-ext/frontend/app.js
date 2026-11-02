const API = 'http://localhost:3000/api';
let session = localStorage.getItem('session') || '';
let currentUser = null;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (session) headers['x-session'] = session;
  const res = await fetch(API + path, { ...opts, headers, credentials: 'include' });
  if (res.status === 401) { session = ''; localStorage.removeItem('session'); }
  return res;
}

async function checkAuth() {
  if (!session) return;
  const r = await api('/auth/me');
  if (r.ok) currentUser = await r.json();
  else { session = ''; localStorage.removeItem('session'); currentUser = null; }
}

const views = {
  home: () => `
    <h2>6:54 PM</h2>
    <p>Tuesday, October 20</p>
    <div class="card">
      <strong>H-Quantum-CLASSICAL Meeting</strong><br>
      Today 2:00 - 3:00 PM<br>
      Host: Jerry Godwin
    </div>
    <div id="authBox"></div>`,

  mail: async () => {
    if (!currentUser) return '<p>Sign in required for Mail.</p>';
    const r = await api('/mail');
    const mails = r.ok ? await r.json() : [];
    return `
      <h2>Mail</h2>
      <div class="card">
        <input id="sub" placeholder="Subject">
        <input id="from" placeholder="From">
        <textarea id="body" placeholder="Message"></textarea>
        <button onclick="sendMail()">Send</button>
      </div>
      <div id="mailList">
        ${mails.map(m => `<div class="list-item"><strong>${m.subject}</strong> – ${m.from}<br>${m.body}</div>`).join('')}
      </div>`;
  },

  whiteboard: async () => {
    if (!currentUser) return '<p>Sign in required for Whiteboard.</p>';
    return `
      <h2>Whiteboard</h2>
      <canvas id="board" width="800" height="500"></canvas>
      <div style="margin-top:10px">
        <button onclick="saveBoard()">Save Board</button>
        <button onclick="clearBoard()">Clear</button>
      </div>`;
  },

  calendar: async () => {
    if (!currentUser) return '<p>Sign in required for Calendar.</p>';
    const r = await api('/calendar');
    const events = r.ok ? await r.json() : [];
    return `
      <h2>Calendar</h2>
      ${events.map(e => `<div class="card"><strong>${e.title}</strong><br>${e.date} ${e.start}-${e.end}<br>Host: ${e.host}</div>`).join('')}
      <div class="card">
        <input id="ctitle" placeholder="Title">
        <input id="cdate" type="date">
        <input id="cstart" type="time">
        <input id="cend" type="time">
        <input id="chost" placeholder="Host">
        <button onclick="addEvent()">Add Event</button>
      </div>`;
  },

  schedule: async () => {
    if (!currentUser) return '<p>Sign in required for Schedule.</p>';
    const r = await api('/schedule');
    const items = r.ok ? await r.json() : [];
    return `
      <h2>Schedule</h2>
      ${items.map(s => `<div class="list-item">${s.title} – ${s.date} ${s.time} (${s.duration} min)</div>`).join('')}
      <div class="card">
        <input id="stitle" placeholder="Meeting title">
        <input id="sdate" type="date">
        <input id="stime" type="time">
        <input id="sdur" type="number" placeholder="Duration (min)" value="30">
        <button onclick="addSchedule()">Schedule</button>
      </div>`;
  },

  notes: async () => {
    if (!currentUser) return '<p>Sign in required for Notes.</p>';
    const r = await api('/notes');
    const notes = r.ok ? await r.json() : [];
    return `
      <h2>My Notes</h2>
      ${notes.map(n => `<div class="card"><strong>${n.title}</strong><br>${n.content}<br><small>${n.updatedAt}</small></div>`).join('')}
      <div class="card">
        <input id="ntitle" placeholder="Title">
        <textarea id="ncontent" placeholder="Note content"></textarea>
        <button onclick="addNote()">Save Note</button>
      </div>`;
  },

  chat: async () => {
    const r = await api('/rooms');
    const rooms = r.ok ? await r.json() : [];
    return `
      <h2>Chat</h2>
      <p style="font-size:12px;color:#666">Meeting chats and #general are public. Updates every 3s. Last 500 messages kept.</p>
      <div id="roomList">${rooms.map(rm => `<button onclick="openRoom('${rm.id}','${rm.name}')">${rm.name}</button>`).join(' ')}</div>
      <div id="chatBox" style="margin-top:16px"></div>`;
  }
};

async function show(view) {
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const html = await views[view]();
  document.getElementById('view').innerHTML = html;
  if (view === 'whiteboard') initBoard();
  if (view === 'home') renderAuth();
  if (view === 'chat') {}
}

function renderAuth() {
  const box = document.getElementById('authBox');
  if (!box) return;
  if (currentUser) {
    box.innerHTML = `<p>Signed in as ${currentUser.name} <button onclick="logout()">Sign out</button></p>`;
  } else {
    box.innerHTML = `
      <div class="card">
        <h3>Sign in</h3>
        <input id="email" placeholder="Email">
        <input id="password" type="password" placeholder="Password">
        <button onclick="login()">Sign in</button>
        <h3 style="margin-top:12px">Register</h3>
        <input id="rname" placeholder="Name">
        <input id="remail" placeholder="Email">
        <input id="rpassword" type="password" placeholder="Password">
        <button onclick="register()">Register</button>
        <p style="font-size:12px;color:#666;margin-top:8px">No password reset or email verification. Session cookie not marked Secure — use HTTPS beyond localhost. Lockout resets on server restart.</p>
      </div>`;
  }
}

async function login() {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value })
  });
  const data = await r.json();
  if (data.session) {
    session = data.session;
    localStorage.setItem('session', session);
    currentUser = data.user;
    show('home');
  } else alert(data.error || 'login failed');
}

async function register() {
  const r = await fetch(API + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('rname').value,
      email: document.getElementById('remail').value,
      password: document.getElementById('rpassword').value
    })
  });
  const data = await r.json();
  if (data.ok) alert('Registered — now sign in');
  else alert(data.error || 'failed');
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  session = '';
  localStorage.removeItem('session');
  currentUser = null;
  show('home');
}

// Mail / Calendar / Schedule / Notes — same as before but using api()
async function sendMail() {
  await api('/mail', { method: 'POST', body: JSON.stringify({
    subject: document.getElementById('sub').value,
    from: document.getElementById('from').value,
    body: document.getElementById('body').value
  })});
  show('mail');
}
async function addEvent() {
  await api('/calendar', { method: 'POST', body: JSON.stringify({
    title: document.getElementById('ctitle').value,
    date: document.getElementById('cdate').value,
    start: document.getElementById('cstart').value,
    end: document.getElementById('cend').value,
    host: document.getElementById('chost').value
  })});
  show('calendar');
}
async function addSchedule() {
  await api('/schedule', { method: 'POST', body: JSON.stringify({
    title: document.getElementById('stitle').value,
    date: document.getElementById('sdate').value,
    time: document.getElementById('stime').value,
    duration: Number(document.getElementById('sdur').value)
  })});
  show('schedule');
}
async function addNote() {
  await api('/notes', { method: 'POST', body: JSON.stringify({
    title: document.getElementById('ntitle').value,
    content: document.getElementById('ncontent').value
  })});
  show('notes');
}

let drawing = false, ctx, canvas;
function initBoard() {
  canvas = document.getElementById('board');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  canvas.onmousedown = () => drawing = true;
  canvas.onmouseup = () => drawing = false;
  canvas.onmousemove = e => {
    if (!drawing) return;
    const r = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
    ctx.stroke();
  };
}
function clearBoard() { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); }
async function saveBoard() {
  if (!canvas) return;
  const data = canvas.toDataURL();
  await api('/whiteboard', { method: 'POST', body: JSON.stringify({ name: 'Board ' + new Date().toLocaleString(), data }) });
  alert('Board saved');
}

// Chat polling every 3s, last 500 on server
let pollTimer = null;
let currentRoom = null;
async function openRoom(id, name) {
  currentRoom = id;
  if (pollTimer) clearInterval(pollTimer);
  async function load() {
    const r = await api('/chat/' + id);
    const msgs = r.ok ? await r.json() : [];
    document.getElementById('chatBox').innerHTML = `
      <h3>${name}</h3>
      <div style="height:300px;overflow:auto;border:1px solid #eee;padding:8px" id="chatMsgs">
        ${msgs.map(m => `<div><strong>${m.from}:</strong> ${m.text}</div>`).join('')}
      </div>
      <input id="chatInput" placeholder="Message" style="width:70%">
      <button onclick="sendChat()">Send</button>`;
    const box = document.getElementById('chatMsgs');
    if (box) box.scrollTop = box.scrollHeight;
  }
  await load();
  pollTimer = setInterval(load, 3000);
}
async function sendChat() {
  if (!currentRoom) return;
  const text = document.getElementById('chatInput').value;
  if (!text) return;
  await api('/chat/' + currentRoom, { method: 'POST', body: JSON.stringify({ text }) });
  document.getElementById('chatInput').value = '';
}

document.querySelectorAll('.nav').forEach(n => n.onclick = () => show(n.dataset.view));

(async () => {
  await checkAuth();
  show('home');
})();
