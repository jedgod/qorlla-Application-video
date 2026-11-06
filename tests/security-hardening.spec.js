const { test, expect } = require('@playwright/test');
const { io } = require('socket.io-client');

test.describe.configure({ mode: 'serial' });

function connectSocket(baseURL, cookie) {
  const socket = io(baseURL, {
    transports: ['websocket'],
    extraHeaders: cookie ? { Cookie: cookie } : {},
    reconnection: false
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out.')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForEvent(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}.`)), 5000);
    socket.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('anonymous host powers require the server-issued cookie and private identifiers stay private', async ({ request, baseURL }) => {
  const create = await request.post('/api/meetings/create', {
    data: { topic: 'Private meeting topic', hostId: 'u_victim' }
  });
  expect(create.status()).toBe(201);
  const body = await create.json();
  const meetingId = body.meeting.meetingId;
  expect(meetingId).toMatch(/^\d{3} \d{4} \d{4}$/);
  expect(body.meeting).not.toHaveProperty('hostId');
  expect(body.meeting).not.toHaveProperty('hostSecretHash');

  const setCookie = (await create.headersArray()).find((header) => header.name.toLowerCase() === 'set-cookie');
  expect(setCookie).toBeTruthy();
  const hostCookie = setCookie.value.split(';', 1)[0];
  const host = await connectSocket(baseURL, hostCookie);
  const hostStatePromise = waitForEvent(host, 'room_state_updated');
  host.emit('join_room', { meetingId, userId: 'u_victim', userName: 'Host' });
  const hostState = await hostStatePromise;
  expect(hostState.participants.find((participant) => participant.socketId === host.id).role).toBe('host');
  expect(hostState.participants.every((participant) => !Object.hasOwn(participant, 'userId'))).toBe(true);
  expect(hostState.meetingMetadata).not.toHaveProperty('hostId');
  expect(hostState.meetingMetadata).not.toHaveProperty('hostSecretHash');

  const guest = await connectSocket(baseURL);
  const guestStatePromise = waitForEvent(guest, 'room_state_updated');
  guest.emit('join_room', { meetingId, userId: 'u_victim', userName: 'Impersonator' });
  const guestState = await guestStatePromise;
  expect(guestState.participants.find((participant) => participant.socketId === guest.id).role).toBe('participant');
  expect(guestState.participants.every((participant) => !Object.hasOwn(participant, 'userId'))).toBe(true);

  const valid = await request.get(`/api/meetings/validate/${encodeURIComponent(meetingId)}`);
  expect(valid.status()).toBe(200);
  expect(await valid.json()).toEqual({ isValid: true });
  const invalid = await request.get('/api/meetings/validate/000%200000%200000');
  expect(invalid.status()).toBe(404);
  expect(await invalid.json()).toEqual({ isValid: false, error: 'Meeting code is invalid or unavailable.' });

  guest.emit('terminate_meeting_session');
  expect((await request.get(`/api/meetings/validate/${encodeURIComponent(meetingId)}`)).status()).toBe(200);

  const endedPromise = waitForEvent(guest, 'meeting_terminated_by_host');
  host.emit('terminate_meeting_session');
  await endedPromise;
  expect((await request.get(`/api/meetings/validate/${encodeURIComponent(meetingId)}`)).status()).toBe(404);
  host.disconnect();
  guest.disconnect();
});

test('cross-origin state changes are denied and meeting validation does not reveal metadata', async ({ request }) => {
  const blocked = await request.post('/api/meetings/create', {
    headers: { Origin: 'https://attacker.example' },
    data: { topic: 'Should not be created' }
  });
  expect(blocked.status()).toBe(403);
  const blockedRegistration = await request.post('/api/auth/register', {
    headers: { Origin: 'https://attacker.example' },
    data: { username: 'attacker', displayName: 'Attacker', password: 'a-long-test-password' }
  });
  expect(blockedRegistration.status()).toBe(403);

  const missing = await request.get('/api/meetings/validate/000%200000%200000');
  expect(missing.headers()['cache-control']).toBe('no-store');
  expect(await missing.json()).toEqual({ isValid: false, error: 'Meeting code is invalid or unavailable.' });

  let throttled;
  for (let attempt = 0; attempt < 21; attempt++) {
    throttled = await request.get('/api/meetings/validate/000%200000%200000');
  }
  expect(throttled.status()).toBe(429);
});
