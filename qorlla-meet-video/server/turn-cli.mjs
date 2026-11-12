// Speaks coturn's telnet-style admin CLI: log in, run commands, return each command's output. Adapted from qorlla-voice-engine/src/turn.mjs (A3.7.1), which proved it against coturn 4.17
// (the voice engine is a separate package, so Meet carries its own copy). Every failure rejects; nothing here swallows an error.
import net from 'node:net';

export async function turnCli(commands, { host, port, password, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host), outs = []; let buf = '', stage = 'login', i = 0, done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* closed */ } err ? reject(err) : resolve(outs); };
    const timer = setTimeout(() => finish(new Error('turn_cli_timeout')), timeoutMs);
    sock.on('error', (e) => finish(e)); sock.on('close', () => finish(done ? undefined : new Error('turn_cli_closed')));
    sock.on('data', (d) => {
      buf += d.toString().replace(/\r/g, '');
      if (stage === 'login' && /Enter password:\s*$/.test(buf)) { buf = ''; stage = 'pw'; sock.write(password + '\r\n'); return; }
      if (stage === 'pw' && /Enter password:\s*$/.test(buf)) return finish(new Error('turn_cli_auth_failed'));
      if ((stage === 'pw' || stage === 'cmd') && /(^|\n)> $/.test(buf)) {
        if (stage === 'cmd') outs.push(buf.replace(/\n> $/, '')); stage = 'cmd';
        buf = ''; if (i >= commands.length) { try { sock.write('quit\r\n'); } catch { /* closed */ } return finish(); }
        sock.write(commands[i++] + '\r\n');
      }
    });
  });
}

/** "  1) id=003000000000000001, user <u1>:" -> [{ id, user }] */
export function parseSessions(text) { return [...String(text).matchAll(/^\s*\d+\)\s+id=([0-9a-fA-F]+),\s+user\s+<([^>]*)>/gm)].map((m) => ({ id: m[1], user: m[2] })); }
