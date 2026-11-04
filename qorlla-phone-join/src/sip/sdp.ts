import crypto from 'node:crypto';
import net from 'node:net';

/**
 * SDP offer/answer for ONE audio stream (RFC 4566 / 3264 subset): G.711 (PCMU, PCMA) + RFC 4733 telephone-event, SRTP with SDES keys (RFC 4568, AES_CM_128_HMAC_SHA1_80). Anything else is refused with a reason,
 * so the caller gets 488 Not Acceptable Here and nothing is allocated. The media address in the offer must be the address the INVITE came from (an offer naming a third party would make this gateway send RTP at it).
 */
export type Crypto = { tag: number; suite: 'AES_CM_128_HMAC_SHA1_80'; key: Buffer };         // key = 16-byte master key || 14-byte master salt
export type Offer = { ip: string; port: number; secure: boolean; codecs: { pt: number; name: 'PCMU' | 'PCMA' }[]; dtmfPt?: number; crypto?: Crypto; direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'; ptime: number };
export type Answer = { sdp: string; codec: 'PCMU' | 'PCMA'; pt: number; dtmfPt?: number; secure: boolean; crypto?: Crypto; ptime: number };
export type SdpRefusal = { refuse: 'no_audio' | 'malformed' | 'codec_mismatch' | 'unencrypted' | 'bad_media_address' | 'bad_direction' };

const STATIC: Record<number, 'PCMU' | 'PCMA'> = { 0: 'PCMU', 8: 'PCMA' };
export function parseOffer(sdp: string): Offer | SdpRefusal {
  if (!sdp || sdp.length > 4096) return { refuse: 'malformed' };
  const lines = sdp.split(/\r?\n/).filter(Boolean); if (!lines.every((l) => /^[a-z]=/.test(l))) return { refuse: 'malformed' };
  let ip = '', port = 0, proto = '', fmts: number[] = [], inAudio = false, audioSeen = false, direction: Offer['direction'] = 'sendrecv', ptime = 20, sessionIp = '';
  const rtpmap = new Map<number, string>(); let crypt: Crypto | undefined;
  for (const l of lines) {
    if (l.startsWith('c=')) { const c = /^c=IN IP([46]) (\S+)$/.exec(l); if (!c || !net.isIP(c[2])) return { refuse: 'malformed' }; if (inAudio) ip = c[2]; else sessionIp = c[2]; }
    else if (l.startsWith('m=')) {
      inAudio = false; const m = /^m=(\w+) (\d{1,5}) (\S+) ([\d ]+)$/.exec(l); if (!m) return { refuse: 'malformed' };
      if (m[1] === 'audio' && !audioSeen) { audioSeen = true; inAudio = true; port = Number(m[2]); proto = m[3]; fmts = m[4].trim().split(/\s+/).map(Number); if (port > 65535) return { refuse: 'malformed' }; }
    } else if (inAudio && l.startsWith('a=')) {
      const a = l.slice(2);
      if (/^(sendrecv|sendonly|recvonly|inactive)$/.test(a)) direction = a as Offer['direction'];
      else if (a.startsWith('rtpmap:')) { const r = /^rtpmap:(\d+) ([A-Za-z0-9-]+)\/(\d+)/.exec(a); if (r) rtpmap.set(Number(r[1]), `${r[2].toLowerCase()}/${r[3]}`); }
      else if (a.startsWith('ptime:')) { const p = Number(a.slice(6)); if ([10, 20, 30, 40].includes(p)) ptime = p; }
      else if (a.startsWith('crypto:') && !crypt) {
        const c = /^crypto:(\d{1,3}) AES_CM_128_HMAC_SHA1_80 inline:([A-Za-z0-9+/]{40})(?:\||;|$)/.exec(a);                       // the only suite accepted; lifetime / MKI parameters are ignored
        if (c) { const key = Buffer.from(c[2], 'base64'); if (key.length === 30) crypt = { tag: Number(c[1]), suite: 'AES_CM_128_HMAC_SHA1_80', key }; }
      }
    }
  }
  if (!audioSeen || port === 0) return { refuse: 'no_audio' }; ip = ip || sessionIp; if (!net.isIP(ip)) return { refuse: 'malformed' };
  const codecs = fmts.filter((p) => STATIC[p]).map((pt) => ({ pt, name: STATIC[pt] }));
  const dtmf = fmts.find((p) => rtpmap.get(p) === 'telephone-event/8000');
  const secure = proto === 'RTP/SAVP'; if (proto !== 'RTP/SAVP' && proto !== 'RTP/AVP') return { refuse: 'malformed' };
  return { ip, port, secure, codecs, dtmfPt: dtmf, crypto: crypt, direction, ptime };
}

export type AnswerPolicy = { ip: string; port: number; allowPlainRtp?: boolean; prefer?: readonly ('PCMU' | 'PCMA')[]; sipSourceIp: string; mediaHostOk?: (sdpIp: string, sipIp: string) => boolean; sessionId?: string };
export function answer(offer: Offer, p: AnswerPolicy): Answer | SdpRefusal {
  if (!(p.mediaHostOk ?? ((a, b) => a === b))(offer.ip, p.sipSourceIp)) return { refuse: 'bad_media_address' };
  if (offer.direction !== 'sendrecv') return { refuse: 'bad_direction' };                                  // a telephone leg must send AND receive; hold / listen-only is not a connected caller
  const prefer = p.prefer ?? ['PCMU', 'PCMA'], chosen = prefer.map((n) => offer.codecs.find((c) => c.name === n)).find(Boolean); if (!chosen) return { refuse: 'codec_mismatch' };
  const secure = offer.secure && !!offer.crypto; if (!secure && !p.allowPlainRtp) return { refuse: 'unencrypted' };
  const crypt: Crypto | undefined = secure ? { tag: offer.crypto!.tag, suite: 'AES_CM_128_HMAC_SHA1_80', key: crypto.randomBytes(30) } : undefined;
  const id = p.sessionId ?? String(Date.now()), v6 = net.isIPv6(p.ip) ? 'IP6' : 'IP4';
  const l = ['v=0', `o=qorlla ${id} ${id} IN ${v6} ${p.ip}`, 's=Qorlla telephone gateway', `c=IN ${v6} ${p.ip}`, 't=0 0', `m=audio ${p.port} ${secure ? 'RTP/SAVP' : 'RTP/AVP'} ${chosen.pt}${offer.dtmfPt !== undefined ? ' ' + offer.dtmfPt : ''}`,
    `a=rtpmap:${chosen.pt} ${chosen.name}/8000`, ...(offer.dtmfPt !== undefined ? [`a=rtpmap:${offer.dtmfPt} telephone-event/8000`, `a=fmtp:${offer.dtmfPt} 0-15`] : []), 'a=ptime:20', 'a=sendrecv'];
  if (crypt) l.push(`a=crypto:${crypt.tag} AES_CM_128_HMAC_SHA1_80 inline:${crypt.key.toString('base64')}`);
  return { sdp: l.join('\r\n') + '\r\n', codec: chosen.name, pt: chosen.pt, dtmfPt: offer.dtmfPt, secure, crypto: crypt, ptime: 20 };
}
/** A synthetic phone's offer (tests and tools). */
export function buildOffer(o: { ip: string; port: number; secure?: boolean; codecs?: ('PCMU' | 'PCMA')[]; dtmfPt?: number | null; key?: Buffer; direction?: string; tag?: number }): { sdp: string; key?: Buffer } {
  const codecs = o.codecs ?? ['PCMU', 'PCMA'], pts = codecs.map((c) => (c === 'PCMU' ? 0 : 8)), dt = o.dtmfPt === undefined ? 101 : o.dtmfPt, key = o.secure === false ? undefined : o.key ?? crypto.randomBytes(30);
  const l = ['v=0', `o=phone 1 1 IN IP4 ${o.ip}`, 's=-', `c=IN IP4 ${o.ip}`, 't=0 0', `m=audio ${o.port} ${key ? 'RTP/SAVP' : 'RTP/AVP'} ${pts.join(' ')}${dt === null ? '' : ' ' + dt}`, ...codecs.map((c, i) => `a=rtpmap:${pts[i]} ${c}/8000`),
    ...(dt === null ? [] : [`a=rtpmap:${dt} telephone-event/8000`, `a=fmtp:${dt} 0-15`]), 'a=ptime:20', `a=${o.direction ?? 'sendrecv'}`];
  if (key) l.push(`a=crypto:${o.tag ?? 1} AES_CM_128_HMAC_SHA1_80 inline:${key.toString('base64')}`);
  return { sdp: l.join('\r\n') + '\r\n', key };
}
