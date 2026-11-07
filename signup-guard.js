/**
 * Sign-up abuse guards for auth.js. Pure helpers, no I/O, so they are easy to test.
 *
 * What these are for: slowing down scripts that create accounts in bulk. What they are NOT: proof of who someone is. There is no
 * device fingerprinting here (it is trivially forged by the person it is meant to stop, collides across identical devices, and is
 * personal data). A determined abuser is made unprofitable by the free-plan quotas in Clips, not "caught" here.
 */
const net = require('net');

/** The network a client belongs to: IPv4 -> its /24, IPv6 -> its /48. Anything else -> null (not limited by network). */
function subnetOf(ip) {
    let a = String(ip || '').trim();
    if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);       // IPv4-mapped IPv6
    if (net.isIPv4(a)) return a.split('.').slice(0, 3).join('.') + '.0/24';
    if (net.isIPv6(a)) {
        const groups = expandV6(a);
        return groups.slice(0, 3).map((g) => g.toString(16)).join(':') + '::/48';
    }
    return null;
}

function expandV6(addr) {
    const a = addr.split('%')[0].toLowerCase();
    const [head, tail] = a.split('::');
    const h = head ? head.split(':') : [];
    const t = tail === undefined ? [] : tail ? tail.split(':') : [];
    const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
    return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

/** Loopback, private and link-local addresses: there is no real client address to limit (a proxy that does not forward the original address). */
function isLocalAddress(ip) {
    let a = String(ip || '').trim();
    if (a.startsWith('::ffff:')) a = a.slice(7);
    if (net.isIPv4(a)) {
        const [p, q] = a.split('.').map(Number);
        return p === 10 || p === 127 || p === 0 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
    }
    if (net.isIPv6(a)) { const g = expandV6(a)[0]; return a === '::1' || a === '::' || (g & 0xfe00) === 0xfc00 || (g & 0xffc0) === 0xfe80; }
    return true;
}

/** Is the client's subnet in the allow list (campus, office)? Entries are subnets as printed by subnetOf, or exact addresses. */
function isAllowedNetwork(ip, allowList) {
    if (!allowList || !allowList.length) return false;
    const s = subnetOf(ip);
    const bare = String(ip || '').replace(/^::ffff:/, '');
    return allowList.some((e) => e === bare || e === s || (s && e === s.replace('/24', '').replace('/48', '')));
}

// Well-known throwaway-mail providers. Not exhaustive: a longer list can be supplied with DISPOSABLE_DOMAINS_FILE (one domain per line).
const BUILTIN_DISPOSABLE = ['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'spam4.me',
    '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com', 'throwawaymail.com', 'yopmail.com', 'yopmail.net', 'yopmail.fr',
    'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com',
    'burnermail.io', 'mailnesia.com', 'mytemp.email', 'tempail.com', 'discard.email', 'spamgourmet.com', 'moakt.com', 'inboxkitten.com', 'mailcatch.com', 'e4ward.com'];

function disposableSet(extra) {
    return new Set([...BUILTIN_DISPOSABLE, ...(extra || [])].map((d) => String(d).trim().toLowerCase()).filter(Boolean));
}

/** True when the address' domain (or a parent domain) is in the set. An empty address is not disposable: e-mail is optional at sign-up. */
function isDisposableEmail(email, set) {
    const at = String(email || '').lastIndexOf('@');
    if (at < 1) return false;
    const parts = String(email).slice(at + 1).trim().toLowerCase().split('.');
    for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return true;     // also sub.mailinator.com
    return false;
}

module.exports = { subnetOf, isLocalAddress, isAllowedNetwork, disposableSet, isDisposableEmail, BUILTIN_DISPOSABLE };
