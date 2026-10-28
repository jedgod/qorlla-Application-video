'use strict';
// The email a guest receives: everything they need to join without an account. One builder, used by the scheduler (invitees when a meeting is created)
// and by the Start screen (Send by email), so both read the same.
//
// The passcode is stored only as a hash, so it can appear in an email ONLY when the host supplies it at the moment of sending. Otherwise the email says a
// passcode is needed and who to ask. Nothing else secret is ever included (no host key, no session, no recording links).
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

function invitationText({ host, title, topic, when, where, meetingId, link, passcode, needsPasscode, agenda, description, dialIn, phonePin }) {
    const h = clean(host, 70) || 'The host', L = [h + ' invited you to a Qorlla meeting.', ''];
    L.push('Meeting: ' + clean(title, 200));
    if (topic) L.push('Topic: ' + clean(topic, 255));
    if (when) L.push('When: ' + clean(when, 200));
    if (where) L.push('Where: ' + clean(where, 200));
    L.push('Host: ' + h, '', 'Meeting ID: ' + meetingId);
    if (link) L.push('Join link: ' + link);
    if (passcode) L.push('Passcode: ' + passcode);
    else if (needsPasscode) L.push('Passcode: this meeting is protected. Ask ' + h + ' for the passcode.');
    // Join by phone: only numbers an operator has really provisioned are listed (never a placeholder). The PIN is stored hashed, so it appears only when supplied at send time.
    const nums = Array.isArray(dialIn) ? dialIn.filter((n) => n && /^\+[1-9]\d{6,14}$/.test(String(n.number || ''))).slice(0, 10) : [];
    if (nums.length) {
        L.push('', 'Join by phone (audio only):', ...nums.map((n) => '  ' + clean(n.country, 60) + (n.label ? ' (' + clean(n.label, 60) + ')' : '') + (n.tollFree ? ' toll-free' : '') + ': ' + n.number), '  Meeting ID: ' + meetingId);
        L.push(/^\d{8}$/.test(String(phonePin || '')) ? '  Telephone access PIN: ' + phonePin : '  Telephone access PIN: ask ' + h + ' for the PIN.');
        L.push('  When prompted, enter the Meeting ID followed by #, then the PIN followed by #. Telephone charges may apply.');
    }
    if (Array.isArray(agenda) && agenda.length) L.push('', 'Agenda:', ...agenda.slice(0, 20).map((a, i) => '  ' + (i + 1) + '. ' + clean(a, 200)));
    if (description) L.push('', clean(description, 600));
    L.push('', 'How to join:', link ? '  1. Open the join link' + (meetingId ? ' (or choose Join in Qorlla and enter the Meeting ID).' : '.') : '  1. Choose Join in Qorlla and enter the Meeting ID.',
        '  2. Enter your name' + (passcode || needsPasscode ? ' and the passcode' : '') + '.', '  3. Check your camera and microphone, then join.',
        '', 'You do not need an account to join. Joining is not consent to be recorded: if the host wants to record, you will be asked first and can decline.');
    return L.join('\n');
}

// Calendar invite (RFC 5545). No passcode or PIN is ever written into it; the join link and Meeting ID are.
const BS = String.fromCharCode(92);
const icsEsc = (v) => String(v ?? '').split(BS).join(BS + BS).replace(/\r?\n/g, BS + 'n').replace(/([,;])/g, BS + '$1');
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function invitationIcs({ uid, title, startIso, minutes, link, meetingId, host, description, now }) {
    const start = new Date(startIso); if (isNaN(start)) return null;
    const end = new Date(start.getTime() + Math.max(5, Math.min(1440, Number(minutes) || 45)) * 60000);
    const body = 'Qorlla meeting. Meeting ID: ' + meetingId + (link ? '\nJoin: ' + link : '') + (description ? '\n\n' + clean(description, 600) : '') + '\n\nThe passcode is not included: ask the host.';
    const fold = (l) => (l.length <= 74 ? l : l.match(/.{1,73}/g).join('\r\n '));
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Qorlla//Meeting//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', 'UID:' + uid + '@qorlla', 'DTSTAMP:' + icsDate(now || new Date()), 'DTSTART:' + icsDate(start), 'DTEND:' + icsDate(end),
        'SUMMARY:' + icsEsc(clean(title, 200) || 'Qorlla meeting'), 'DESCRIPTION:' + icsEsc(body), link ? 'URL:' + link : null, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).map(fold).join('\r\n') + '\r\n';
}
module.exports = { invitationText, invitationIcs, icsEsc };
