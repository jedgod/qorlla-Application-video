// Browser side of the step-up ceremonies (passkeys / WebAuthn). No dependencies. The server (adminServer) decides everything; this only
// moves bytes between navigator.credentials and the web tier's proxy routes. Nothing here is trusted by the server.
//
//   import { registerPasskey, stepUp } from '/qorlla-stepup.js';
//   await registerPasskey({ csrf, enrollmentToken });          // once per authenticator
//   await stepUp({ csrf, action: 'override.set' });            // right before a privileged action; the proof is spent by that action

const toBuf = (s) => { const p = s.replace(/-/g, '+').replace(/_/g, '/'); const b = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const toB64u = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

async function post(url, body, csrf) {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  return { status: r.status, body: out };
}

export class StepUpError extends Error {
  constructor(message, status, body) { super(message); this.name = 'StepUpError'; this.status = status; this.body = body; }
}
const must = (r, what) => { if (r.status !== 200) throw new StepUpError(`${what} failed (${r.status}${r.body?.error ? ': ' + r.body.error : ''})`, r.status, r.body); return r.body; };

export async function registerPasskey({ csrf, enrollmentToken, userName, label = 'This device', base = '/api/admin/stepup' }) {
  const o = must(await post(`${base}/passkey/register/begin`, { userName, enrollmentToken }, csrf), 'registration start');
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: toBuf(o.challenge), rp: o.rp, user: { id: toBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout, attestation: o.attestation, authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  } });
  const response = { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment, clientExtensionResults: cred.getClientExtensionResults(),
    response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject), transports: cred.response.getTransports?.() || [] } };
  return must(await post(`${base}/passkey/register/finish`, { response, label, enrollmentToken }, csrf), 'registration finish');
}

export async function stepUp({ csrf, action, base = '/api/admin/stepup' }) {
  const o = must(await post(`${base}/passkey/assert/begin`, { action }, csrf), 'step-up start');
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: toBuf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification,
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  } });
  const response = { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment, clientExtensionResults: cred.getClientExtensionResults(),
    response: { authenticatorData: toB64u(cred.response.authenticatorData), clientDataJSON: toB64u(cred.response.clientDataJSON), signature: toB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null } };
  return must(await post(`${base}/passkey/assert/finish`, { action, response }, csrf), 'step-up finish');
}
