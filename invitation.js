'use strict';
// The email a guest receives: everything they need to join without an account. One builder, used by the scheduler (invitees when a meeting is created)
// and by the Start screen (Send by email), so both read the same.
//
// The passcode is stored only as a hash, so it can appear in an email ONLY when the host supplies it at the moment of sending. Otherwise the email says a
// passcode is needed and who to ask. Nothing else secret is ever included (no host key, no session, no recording links).
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

function invitationText({ host, title, topic, when, where, meetingId, link, passcode, needsPasscode, agenda, description }) {
    const h = clean(host, 70) || 'The host', L = [h + ' invited you to a Qorlla meeting.', ''];
    L.push('Meeting: ' + clean(title, 200));
    if (topic) L.push('Topic: ' + clean(topic, 255));
    if (when) L.push('When: ' + clean(when, 200));
    if (where) L.push('Where: ' + clean(where, 200));
    L.push('Host: ' + h, '', 'Meeting ID: ' + meetingId);
    if (link) L.push('Join link: ' + link);
    if (passcode) L.push('Passcode: ' + passcode);
    else if (needsPasscode) L.push('Passcode: this meeting is protected. Ask ' + h + ' for the passcode.');
    if (Array.isArray(agenda) && agenda.length) L.push('', 'Agenda:', ...agenda.slice(0, 20).map((a, i) => '  ' + (i + 1) + '. ' + clean(a, 200)));
    if (description) L.push('', clean(description, 600));
    L.push('', 'How to join:', link ? '  1. Open the join link' + (meetingId ? ' (or choose Join in Qorlla and enter the Meeting ID).' : '.') : '  1. Choose Join in Qorlla and enter the Meeting ID.',
        '  2. Enter your name' + (passcode || needsPasscode ? ' and the passcode' : '') + '.', '  3. Check your camera and microphone, then join.',
        '', 'You do not need an account to join. Joining is not consent to be recorded: if the host wants to record, you will be asked first and can decline.');
    return L.join('\n');
}
module.exports = { invitationText };
