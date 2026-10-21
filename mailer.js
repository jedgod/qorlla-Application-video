/**
 * Outbound email for account emails (verification, password reset) and external mail.
 *
 * Configure with environment variables:
 *   SMTP_URL    e.g. smtps://user:pass@smtp.example.com:465   (or smtp://host:587)
 *   SMTP_FROM   address mail is sent from, e.g. "Qorlla <no-reply@example.com>"
 *   PUBLIC_URL  the site's public address, used in email links, e.g. https://qorlla.example.com
 *   MAIL_OUTBOX set to 1 to save un-sent system emails to data/auth/outbox.json (development only)
 *
 * Without SMTP_URL and SMTP_FROM nothing is sent, and the app says so instead of pretending.
 * Note: this server can SEND mail but cannot RECEIVE it; replies go to the sender's own inbox
 * (Reply-To), not back into Qorlla.
 */

const path = require('path');
const nodemailer = require('nodemailer');
const store = require('./store');

const ADDRESS_RE = /^[^\s@,;<>"'()\\]+@[^\s@,;<>"'()\\]+\.[A-Za-z]{2,}$/;
const clean = (s, max) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

function isValidAddress(addr) {
    return typeof addr === 'string' && addr.length <= 254 && ADDRESS_RE.test(addr);
}

module.exports = function createMailer({ dataDir }) {
    const smtpUrl = process.env.SMTP_URL || '';
    const from = process.env.SMTP_FROM || '';
    const configured = !!(smtpUrl && from);
    const outboxFile = path.join(dataDir, 'auth', 'outbox.json');
    const production = process.env.NODE_ENV === 'production';

    // Links in emails must point at OUR site. Never derive them from the request's Host header,
    // which an attacker controls. In production PUBLIC_URL is required.
    let baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    if (!baseUrl && !production) baseUrl = 'http://localhost:' + (process.env.PORT || 5000);

    let transport = null;
    if (configured) {
        transport = nodemailer.createTransport(smtpUrl, { connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000 });
    }

    function saveToOutbox(message) {
        if (process.env.MAIL_OUTBOX !== '1') return false;
        const box = store.readJson(outboxFile, []);
        box.unshift({ at: new Date().toISOString(), ...message });
        store.writeJson(outboxFile, box.slice(0, 50));
        return true;
    }

    /**
     * Sends one message. Resolves to { status, error? } and never throws:
     *   sent | failed | not_configured | invalid_address
     */
    async function send({ to, subject, text, replyTo, system }) {
        if (!isValidAddress(to)) return { status: 'invalid_address' };
        const message = { to, subject: clean(subject, 200), text: String(text || '').slice(0, 20000) };
        if (replyTo && isValidAddress(replyTo)) message.replyTo = replyTo;
        if (!transport) {
            if (system) saveToOutbox(message);
            return { status: 'not_configured' };
        }
        try {
            await transport.sendMail({ from, ...message });
            return { status: 'sent' };
        } catch (err) {
            console.error('[Mailer]: send failed:', err.code || err.message);
            return { status: 'failed', error: 'The mail server rejected or could not deliver the message.' };
        }
    }

    return {
        send,
        configured,
        // Email features (verification, reset, external mail) need both a transport and a trustworthy link base
        enabled: configured && !!baseUrl,
        baseUrl,
        isValidAddress
    };
};

module.exports.isValidAddress = isValidAddress;
