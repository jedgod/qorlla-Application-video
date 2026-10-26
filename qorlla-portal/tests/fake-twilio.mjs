// TEST DOUBLE ONLY (not Twilio). A local stand-in for the two provider REST endpoints the portal uses (create call, download recording),
// plus helpers that sign webhooks exactly the way the documented Twilio algorithm does. It proves OUR handling of provider traffic;
// a passing run is NOT evidence that a real call, number or recording works with the real provider.
import http from 'node:http';
import { signFor } from '../server/telephony/twilio.mjs';

export const SID = 'AC' + 'a'.repeat(32);
export const TOKEN = 'twilio-test-auth-token-0123456789';

export async function startFakeTwilio({ port = 0, host = '127.0.0.1' } = {}) {
  const st = { calls: [], recordingRequests: [], failCalls: false, n: 0 };
  const server = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x); const raw = Buffer.concat(c).toString();
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const authed = req.headers.authorization === 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
    if (req.method === 'POST' && req.url === `/2010-04-01/Accounts/${SID}/Calls.json`) {
      if (!authed) return send(401, { message: 'Authenticate' });
      if (st.failCalls) return send(400, { message: 'The number is unverified', code: 21219 });
      const form = Object.fromEntries(new URLSearchParams(raw)); st.calls.push(form); return send(201, { sid: 'CA' + String(++st.n).padStart(32, '0'), status: 'queued' });
    }
    const rec = /^\/2010-04-01\/Accounts\/[A-Za-z0-9]+\/Recordings\/(RE[A-Za-z0-9]+)\.mp3$/.exec(req.url);
    if (req.method === 'GET' && rec) {
      st.recordingRequests.push({ id: rec[1], authed });
      if (!authed) { res.writeHead(401); return res.end(); }
      if (rec[1].startsWith('REmissing')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('ID3-test-double-audio'));
    }
    send(404, { message: 'unknown' });
  });
  await new Promise((r) => server.listen(port, host, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { st, url, close: () => new Promise((r) => server.close(r)), recordingUrl: (id) => `${url}/2010-04-01/Accounts/${SID}/Recordings/${id}` };
}

/** POST a provider webhook to the portal with a valid (or deliberately wrong) signature. `publicOrigin` is the configured public origin. */
export async function webhook(base, publicOrigin, path, params, { token = TOKEN, signature } = {}) {
  const sig = signature === undefined ? signFor({ authToken: token, url: publicOrigin + path, params }) : signature;
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sig ? { 'x-twilio-signature': sig } : {}) }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
