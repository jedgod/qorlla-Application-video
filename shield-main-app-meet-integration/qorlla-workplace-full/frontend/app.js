const API = 'http://localhost:3000/api';

const views = {
  home: () => `
    <h2>6:54 PM</h2>
    <p>Tuesday, October 20</p>
    <div class="card">
      <strong>H-Quantum-CLASSICAL Meeting</strong><br>
      Today 2:00 - 3:00 PM<br>
      Host: Jerry Godwin
    </div>`,

  mail: async () => {
    const mails = await fetch(API + '/mail').then(r => r.json());
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

  whiteboard: () => `
    <h2>Whiteboard</h2>
    <canvas id="board" width="800" height="500"></canvas>
    <div style="margin-top:10px">
      <button onclick="saveBoard()">Save Board</button>
      <button onclick="clearBoard()">Clear</button>
    </div>`,

  calendar: async () => {
    const events = await fetch(API + '/calendar').then(r => r.json());
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
    const items = await fetch(API + '/schedule').then(r => r.json());
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
    const notes = await fetch(API + '/notes').then(r => r.json());
    return `
      <h2>My Notes</h2>
      ${notes.map(n => `<div class="card"><strong>${n.title}</strong><br>${n.content}<br><small>${n.updatedAt}</small></div>`).join('')}
      <div class="card">
        <input id="ntitle" placeholder="Title">
        <textarea id="ncontent" placeholder="Note content"></textarea>
        <button onclick="addNote()">Save Note</button>
      </div>`;
  }
};

async function show(view) {
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const html = await views[view]();
  document.getElementById('view').innerHTML = html;
  if (view === 'whiteboard') initBoard();
}

document.querySelectorAll('.nav').forEach(n => n.onclick = () => show(n.dataset.view));

// Mail
async function sendMail() {
  await fetch(API + '/mail', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      subject: document.getElementById('sub').value,
      from: document.getElementById('from').value,
      body: document.getElementById('body').value
    })
  });
  show('mail');
}

// Calendar
async function addEvent() {
  await fetch(API + '/calendar', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      title: document.getElementById('ctitle').value,
      date: document.getElementById('cdate').value,
      start: document.getElementById('cstart').value,
      end: document.getElementById('cend').value,
      host: document.getElementById('chost').value
    })
  });
  show('calendar');
}

// Schedule
async function addSchedule() {
  await fetch(API + '/schedule', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      title: document.getElementById('stitle').value,
      date: document.getElementById('sdate').value,
      time: document.getElementById('stime').value,
      duration: Number(document.getElementById('sdur').value)
    })
  });
  show('schedule');
}

// Notes
async function addNote() {
  await fetch(API + '/notes', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      title: document.getElementById('ntitle').value,
      content: document.getElementById('ncontent').value
    })
  });
  show('notes');
}

// Whiteboard
let drawing = false, ctx, canvas;
function initBoard() {
  canvas = document.getElementById('board');
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
function clearBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
async function saveBoard() {
  const data = canvas.toDataURL();
  await fetch(API + '/whiteboard', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: 'Board ' + new Date().toLocaleString(), data })
  });
  alert('Board saved');
}

show('home');
