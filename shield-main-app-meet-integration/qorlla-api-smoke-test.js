'use strict';

// Smoke test for qorlla-api-client.js. Usage (Node 18+):
//   node qorlla-api-smoke-test.js [baseUrl]
// Registers a throwaway account, then exercises the main endpoints.

const { createQorllaAPI } = require('./qorlla-api-client');

const baseUrl = process.argv[2] || 'http://localhost:5000';
const api = createQorllaAPI({ baseUrl, credentials: 'omit' });

let failed = 0;

async function step(name, fn) {
  try {
    const result = await fn();
    console.log(`PASS ${name}`);
    return result;
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.status || ''} ${err.message}`);
  }
}

(async () => {
  const username = `smoke${Date.now().toString(36)}`.slice(0, 24);
  const password = 'SmokeTest123';

  await step('health', () => api.health());
  await step('auth.config', () => api.auth.config());
  await step('auth.register', () => api.auth.register({ username, displayName: 'Smoke Test', password }));
  const login = await step('auth.login', () => api.auth.login({ username, password }));
  console.log(`     session cookie captured: ${api.sessionCookie ? 'yes' : 'NO'}`);
  if (!api.sessionCookie) failed++;

  await step('auth.me', () => api.auth.me());
  await step('auth.users', () => api.auth.users('smoke'));

  const note = await step('notes.create', () => api.workplace.notes.create({ title: 'smoke', body: 'hello' }));
  if (note && note.id) {
    await step('notes.update (PUT)', () => api.workplace.notes.update(note.id, { title: 'smoke2', body: 'hi' }));
    await step('notes.delete', () => api.workplace.notes.delete(note.id));
  }
  await step('mail.list', () => api.workplace.mail.list());
  await step('calendar.list', () => api.workplace.calendar.list());
  await step('schedule.list', () => api.workplace.schedule.list());
  await step('chat.list', () => api.workplace.chat.list());

  const meeting = await step('meetings.create', () => api.meetings.create({
    topic: 'Smoke Meeting',
    hostId: login && login.user && login.user.id,
    durationMinutes: 15
  }));
  if (meeting && meeting.meeting) {
    await step('meetings.validate', () => api.meetings.validate(meeting.meeting.meetingId));
  }

  await step('appointments.slots', () => api.appointments.slots('host_jane_doe', '2026-11-16'));
  await step('docs.forMeeting', () => api.docs.forMeeting('858 9833 3712'));
  await step('docs.upload', () => api.docs.upload(new Blob(['smoke']), 'smoke.txt', { userId: 'smoke' }));
  await step('postMeeting.summary (404 expected if not concluded)', async () => {
    try {
      await api.postMeeting.summary('000 0000 0000');
    } catch (err) {
      if (err.status === 404) return;
      throw err;
    }
  });
  await step('notifications.auditLog', () => api.notifications.auditLog());

  await step('auth.logout', () => api.auth.logout());

  console.log(failed ? `\n${failed} failure(s)` : '\nAll steps passed');
  process.exit(failed ? 1 : 0);
})();
