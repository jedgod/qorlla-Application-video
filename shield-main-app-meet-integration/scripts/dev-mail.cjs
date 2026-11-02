// Development mail catcher: a tiny local SMTP server that ACCEPTS every message instead of delivering it, plus a page that shows what was "sent".
//   SMTP  127.0.0.1:1025   (MAIL_PORT)         viewer  http://localhost:3225/   (MAIL_VIEW_PORT)
// It lets you see the Qorlla invitation, verification and reset emails on this computer without any mail account. NOTHING reaches a real inbox.
// For real delivery set SMTP_URL and SMTP_FROM (and PUBLIC_URL) to a real provider; `npm run dev:stack` then does not start this catcher.
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SMTP_PORT = Number(process.env.MAIL_PORT || 1025), VIEW_PORT = Number(process.env.MAIL_VIEW_PORT || 3225), BIND = '127.0.0.1';
const FILE = process.env.MAIL_STORE || path.join(__dirname, '..', '.dev-stack', 'mail.json');
let box = []; try { box = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { box = []; }
const persist = () => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(box.slice(0, 100))); } catch (e) { /* viewer still works from memory */ } };

const qp = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const utf8 = (latin) => Buffer.from(latin, 'latin1').toString('utf8');
function header(h, name) { const m = new RegExp('^' + name + ':[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)', 'im').exec(h); return m ? m[1].replace(/\r?\n[ \t]+/g, ' ') : ''; }
function decodeWords(s) { return s.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, cs, enc, t) => (enc.toUpperCase() === 'B' ? Buffer.from(t, 'base64').toString('utf8') : utf8(qp(t.replace(/_/g, ' '))))); }
function parse(raw, from, to) {
  const i = raw.indexOf('\r\n\r\n'), head = i < 0 ? raw : raw.slice(0, i); let body = i < 0 ? '' : raw.slice(i + 4);
  const cte = header(head, 'Content-Transfer-Encoding').toLowerCase();
  if (cte.includes('quoted-printable')) body = utf8(qp(body)); else if (cte.includes('base64')) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return { at: new Date().toISOString(), from, to, subject: decodeWords(header(head, 'Subject')), replyTo: decodeWords(header(head, 'Reply-To')), text: body.replace(/\r\n/g, '\n') };
}

const smtp = net.createServer((socket) => {
  let mode = 'cmd', buf = '', cur = { from: '', to: [], data: '' };
  const say = (l) => socket.write(l + '\r\n');
  say('220 qorlla-dev-mail ready');
  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    for (;;) {
      if (mode === 'data') {
        const end = buf.indexOf('\r\n.\r\n'); if (end === -1) return;
        cur.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.'); buf = buf.slice(end + 5); mode = 'cmd';
        box.unshift(parse(cur.data, cur.from, cur.to)); box = box.slice(0, 100); persist(); cur = { from: '', to: [], data: '' }; say('250 accepted (development catcher: not delivered)'); continue;
      }
      const nl = buf.indexOf('\r\n'); if (nl === -1) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2); const c = line.toUpperCase();
      if (c.startsWith('EHLO') || c.startsWith('HELO')) socket.write('250-qorlla-dev-mail\r\n250 8BITMIME\r\n');
      else if (c.startsWith('MAIL FROM')) { cur.from = line.slice(10).replace(/[<>]/g, '').trim(); say('250 ok'); }
      else if (c.startsWith('RCPT TO')) { cur.to.push(line.slice(8).replace(/[<>]/g, '').trim()); say('250 ok'); }
      else if (c === 'DATA') { mode = 'data'; say('354 end with <CRLF>.<CRLF>'); }
      else if (c === 'QUIT') { say('221 bye'); socket.end(); return; }
      else say('250 ok');
    }
  });
  socket.on('error', () => {});
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
const view = http.createServer((req, res) => {
  if (req.url === '/messages.json') return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(box));
  if (req.method === 'POST' && req.url === '/clear') { box = []; persist(); return res.writeHead(303, { Location: '/' }).end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qorlla dev mail</title><style>body{font:15px system-ui;max-width:860px;margin:24px auto;padding:0 14px;color:#0f172a}.m{border:1px solid #cbd5e1;border-radius:12px;padding:12px 16px;margin:12px 0}.h{color:#475569;font-size:13px}pre{white-space:pre-wrap;font:14px/1.5 system-ui;margin:8px 0 0}.b{background:#fef3c7;border-radius:10px;padding:8px 12px}button{font:inherit}</style>'
    + '<h1>Qorlla development mail</h1><p class="b">These messages were caught on this computer. <b>Nothing was delivered to a real inbox.</b> Set SMTP_URL / SMTP_FROM to a real provider for real delivery.</p><form method="post" action="/clear"><button>Clear all</button></form>'
    + (box.length ? box.map((m) => '<article class="m"><div class="h">' + esc(new Date(m.at).toLocaleString()) + ' &middot; To: <b>' + esc(m.to.join(', ')) + '</b>' + (m.replyTo ? ' &middot; Reply-To: ' + esc(m.replyTo) : '') + '</div><h3>' + esc(m.subject) + '</h3><pre>' + linkify(m.text) + '</pre></article>').join('') : '<p>No messages yet.</p>'));
});
smtp.listen(SMTP_PORT, BIND, () => console.log('[mail] dev SMTP catcher on ' + BIND + ':' + SMTP_PORT));
view.listen(VIEW_PORT, BIND, () => console.log('[mail] messages: http://localhost:' + VIEW_PORT + '/'));
for (const s of [smtp, view]) s.on('error', (e) => { console.error('[mail] ' + e.message); process.exit(1); });
