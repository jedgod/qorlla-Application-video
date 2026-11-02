// Minimal local SMTP server for tests: accepts every message and keeps it in memory. It proves the application's reset/verify flows end to end;
// it does NOT certify delivery through a real mail provider.
const net = require('net');

function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function startSmtpSink() {
  const messages = [];
  const server = net.createServer((socket) => {
    let mode = 'cmd'; let buf = ''; let current = { to: [], from: '', data: '' };
    const send = (line) => socket.write(line + '\r\n');
    send('220 sink ESMTP ready');
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        if (mode === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buf.slice(0, end); buf = buf.slice(end + 5); mode = 'cmd';
          messages.push({ from: current.from, to: current.to, raw: current.data, text: decodeQuotedPrintable(current.data) });
          current = { to: [], from: '', data: '' }; send('250 queued'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl === -1) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2); const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) { socket.write('250-sink\r\n250 8BITMIME\r\n'); }
        else if (cmd.startsWith('MAIL FROM')) { current.from = line.slice(10).trim(); send('250 ok'); }
        else if (cmd.startsWith('RCPT TO')) { current.to.push(line.slice(8).trim().replace(/[<>]/g, '')); send('250 ok'); }
        else if (cmd === 'DATA') { mode = 'data'; send('354 go ahead'); }
        else if (cmd === 'RSET') send('250 ok');
        else if (cmd === 'NOOP') send('250 ok');
        else if (cmd === 'QUIT') { send('221 bye'); socket.end(); return; }
        else send('250 ok');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, messages,
    waitFor: async (pred, ms = 8000) => { const t = Date.now(); for (;;) { const m = messages.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error('no matching mail arrived'); await new Promise((r) => setTimeout(r, 50)); } },
    close: () => new Promise((r) => server.close(r))
  })));
}
module.exports = { startSmtpSink };
