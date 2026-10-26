'use strict';

class QorllaAPI {
  constructor({
    baseUrl = 'http://localhost:5000',
    fetchImpl = globalThis.fetch,
    credentials = 'include',
    sessionCookie = '',
    defaultHeaders = {}
  } = {}) {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required. In Node, use node-fetch or a global fetch in newer runtimes.');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.credentials = credentials;
    this.sessionCookie = sessionCookie;
    this.defaultHeaders = { 'Content-Type': 'application/json', ...defaultHeaders };
  }

  setSessionCookie(cookie) {
    this.sessionCookie = cookie;
    return this;
  }

  // Node has no cookie jar, so keep the qs cookie from Set-Cookie. Browsers hide
  // Set-Cookie from scripts (getSetCookie returns nothing) and manage it themselves.
  captureSessionCookie(response) {
    if (!response.headers || typeof response.headers.getSetCookie !== 'function') return;
    for (const header of response.headers.getSetCookie()) {
      const match = /^qs=([^;]*)/.exec(header);
      if (match) this.sessionCookie = match[1] ? `qs=${match[1]}` : '';
    }
  }

  buildUrl(path, query = {}) {
    const url = new URL(path, this.baseUrl + '/');
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  async request(path, {
    method = 'GET',
    body,
    query = {},
    headers = {},
    json = true,
    raw = false
  } = {}) {
    const url = this.buildUrl(path, query);
    const init = {
      method,
      credentials: this.credentials,
      headers: { ...this.defaultHeaders, ...headers }
    };

    if (this.sessionCookie) {
      init.headers.Cookie = this.sessionCookie;
    }

    // Lets callers drop a default header (e.g. Content-Type for multipart uploads).
    Object.keys(init.headers).forEach((key) => {
      if (init.headers[key] === undefined) delete init.headers[key];
    });

    if (body !== undefined && body !== null) {
      init.body = json ? JSON.stringify(body) : body;
    }

    const response = await this.fetchImpl(url, init);
    this.captureSessionCookie(response);
    const text = await response.text();
    let data = text;
    if (text && json) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = text;
      }
    }

    if (!response.ok) {
      const error = (typeof data === 'object' && data !== null && data.error) ? data.error : response.statusText || 'Request failed';
      const err = new Error(error);
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return raw ? { response, data } : data;
  }

  health() {
    return this.request('/api/health');
  }

  auth = {
    config: () => this.request('/api/auth/config'),
    register: (payload) => this.request('/api/auth/register', { method: 'POST', body: payload }),
    login: (payload) => this.request('/api/auth/login', { method: 'POST', body: payload }),
    logout: () => this.request('/api/auth/logout', { method: 'POST' }),
    me: () => this.request('/api/auth/me'),
    updateMe: (payload) => this.request('/api/auth/me', { method: 'PATCH', body: payload }),
    changePassword: (payload) => this.request('/api/auth/password', { method: 'POST', body: payload }),
    updateEmail: (payload) => this.request('/api/auth/email', { method: 'POST', body: payload }),
    verifyResend: () => this.request('/api/auth/verify/resend', { method: 'POST' }),
    verify: (token) => this.request('/api/auth/verify', { method: 'POST', body: { token } }),
    forgotPassword: (username) => this.request('/api/auth/forgot', { method: 'POST', body: { username } }),
    resetPassword: (token, password) => this.request('/api/auth/reset', { method: 'POST', body: { token, password } }),
    recover: (username, code) => this.request('/api/auth/recover', { method: 'POST', body: { username, code } }),
    newRecoveryCodes: () => this.request('/api/auth/recovery-codes', { method: 'POST' }),
    users: (q = '') => this.request('/api/auth/users', { query: { q } })
  };

  workplace = {
    mail: {
      list: () => this.request('/api/workplace/mail'),
      create: (payload) => this.request('/api/workplace/mail', { method: 'POST', body: payload }),
      update: (id, patch) => this.request(`/api/workplace/mail/${id}`, { method: 'PATCH', body: patch }),
      delete: (id) => this.request(`/api/workplace/mail/${id}`, { method: 'DELETE' })
    },
    notes: {
      list: () => this.request('/api/workplace/notes'),
      create: (payload) => this.request('/api/workplace/notes', { method: 'POST', body: payload }),
      update: (id, patch) => this.request(`/api/workplace/notes/${id}`, { method: 'PUT', body: patch }),
      delete: (id) => this.request(`/api/workplace/notes/${id}`, { method: 'DELETE' })
    },
    calendar: {
      list: () => this.request('/api/workplace/calendar'),
      create: (payload) => this.request('/api/workplace/calendar', { method: 'POST', body: payload }),
      delete: (id) => this.request(`/api/workplace/calendar/${id}`, { method: 'DELETE' })
    },
    schedule: {
      list: () => this.request('/api/workplace/schedule'),
      create: (payload) => this.request('/api/workplace/schedule', { method: 'POST', body: payload }),
      delete: (id) => this.request(`/api/workplace/schedule/${id}`, { method: 'DELETE' })
    },
    whiteboard: {
      list: () => this.request('/api/workplace/whiteboard'),
      create: (payload) => this.request('/api/workplace/whiteboard', { method: 'POST', body: payload }),
      update: (id, payload) => this.request(`/api/workplace/whiteboard/${id}`, { method: 'PUT', body: payload })
    },
    chat: {
      list: () => this.request('/api/workplace/chat'),
      directory: (q = '') => this.request('/api/workplace/chat/directory', { query: { q } }),
      create: (payload) => this.request('/api/workplace/chat', { method: 'POST', body: payload }),
      dm: (username) => this.request('/api/workplace/chat/dm', { method: 'POST', body: { username } }),
      readAll: () => this.request('/api/workplace/chat/read-all', { method: 'POST' }),
      join: (chatId) => this.request(`/api/workplace/chat/${chatId}/join`, { method: 'POST' }),
      leave: (chatId) => this.request(`/api/workplace/chat/${chatId}/leave`, { method: 'POST' }),
      markRead: (chatId) => this.request(`/api/workplace/chat/${chatId}/read`, { method: 'POST' }),
      addMember: (chatId, username) => this.request(`/api/workplace/chat/${chatId}/members`, { method: 'POST', body: { username } }),
      removeMember: (chatId, username) => this.request(`/api/workplace/chat/${chatId}/members/remove`, { method: 'POST', body: { username } }),
      sendMessage: (chatId, text) => this.request(`/api/workplace/chat/${chatId}/messages`, { method: 'POST', body: { text } }),
      getMessages: (chatId, { before, limit = 50 } = {}) => this.request(`/api/workplace/chat/${chatId}/messages`, { query: { before, limit } }),
      vote: (chatId, messageId) => this.request(`/api/workplace/chat/${chatId}/messages/${messageId}/vote`, { method: 'POST' }),
      closePoll: (chatId, messageId) => this.request(`/api/workplace/chat/${chatId}/messages/${messageId}/close`, { method: 'POST' }),
      update: (chatId, patch) => this.request(`/api/workplace/chat/${chatId}`, { method: 'PATCH', body: patch }),
      delete: (chatId) => this.request(`/api/workplace/chat/${chatId}`, { method: 'DELETE' })
    }
  };

  meetings = {
    create: (payload) => this.request('/api/meetings/create', { method: 'POST', body: payload }),
    validate: (meetingId) => this.request(`/api/meetings/validate/${encodeURIComponent(meetingId)}`)
  };

  appointments = {
    // date is YYYY-MM-DD
    slots: (hostId, date) => this.request('/api/appointments/slots', { query: { hostId, date } }),
    book: ({ hostId, topic, startTimeString, participantEmail }) =>
      this.request('/api/appointments/book', { method: 'POST', body: { hostId, topic, startTimeString, participantEmail } })
  };

  docs = {
    // file: Blob/File (or Buffer-backed Blob in Node); fileName must end in pdf|docx|pptx|xlsx|png|jpg|jpeg|txt; max 25MB
    upload: (file, fileName, { userId, targetMeetingId } = {}) => {
      const form = new FormData();
      form.append('attachedFile', file, fileName);
      if (userId) form.append('userId', userId);
      if (targetMeetingId) form.append('targetMeetingId', targetMeetingId);
      return this.request('/api/docs/upload', {
        method: 'POST',
        body: form,
        json: false,
        headers: { 'Content-Type': undefined }
      });
    },
    linkToMeeting: (documentId, meetingId) =>
      this.request('/api/docs/link-to-meeting', { method: 'POST', body: { documentId, meetingId } }),
    forMeeting: (meetingId) => this.request(`/api/docs/meeting/${encodeURIComponent(meetingId)}`)
  };

  postMeeting = {
    conclude: (meetingId) => this.request('/api/post-meeting/conclude', { method: 'POST', body: { meetingId } }),
    summary: (meetingId) => this.request(`/api/post-meeting/summary/${encodeURIComponent(meetingId)}`)
  };

  notifications = {
    // eventType: MEETING_INVITE | CHAT_MENTION | DOCUMENT_UPLOADED | SUMMARY_COMPLETED
    trigger: ({ eventType, recipientUserId, metadata }) =>
      this.request('/api/notifications/trigger', { method: 'POST', body: { eventType, recipientUserId, metadata } }),
    auditLog: () => this.request('/api/notifications/audit-log')
  };
}

const createQorllaAPI = (options) => new QorllaAPI(options);

if (typeof module !== 'undefined') {
  module.exports = { QorllaAPI, createQorllaAPI };
}

if (typeof window !== 'undefined') {
  window.QorllaAPI = QorllaAPI;
  window.createQorllaAPI = createQorllaAPI;
}
