'use strict';

const { createQorllaAPI } = require('./qorlla-api-client');

class QorllaAppClient {
  constructor({ baseUrl = 'http://localhost:5000', credentials = 'include', sessionCookie = '' } = {}) {
    this.api = createQorllaAPI({ baseUrl, credentials, sessionCookie });
    this.user = null;
    this.session = { authenticated: false };
  }

  setSessionCookie(cookie) {
    this.api.setSessionCookie(cookie);
    this.session.cookie = cookie;
    return this;
  }

  async bootstrap() {
    try {
      const result = await this.api.auth.me();
      this.user = result.user || null;
      this.session.authenticated = !!this.user;
      return this.user;
    } catch (err) {
      this.user = null;
      this.session.authenticated = false;
      return null;
    }
  }

  async login(username, password) {
    const result = await this.api.auth.login({ username, password });
    this.user = result.user || null;
    this.session.authenticated = !!this.user;
    return result;
  }

  async register({ username, displayName, password, email }) {
    const result = await this.api.auth.register({ username, displayName, password, email });
    this.user = result.user || null;
    this.session.authenticated = !!this.user;
    return result;
  }

  async logout() {
    await this.api.auth.logout();
    this.user = null;
    this.session.authenticated = false;
    return true;
  }

  async getProfile() {
    const result = await this.api.auth.me();
    this.user = result.user || null;
    return this.user;
  }

  async getChats() {
    return this.api.workplace.chat.list();
  }

  async getMessages(chatId, options = {}) {
    return this.api.workplace.chat.getMessages(chatId, options);
  }

  async sendMessage(chatId, text) {
    return this.api.workplace.chat.sendMessage(chatId, text);
  }

  async createChat({ type, name, public: isPublic, usernames = [] }) {
    return this.api.workplace.chat.create({ type, name, public: isPublic, usernames });
  }

  async createDM(username) {
    return this.api.workplace.chat.dm(username);
  }

  async createMeeting({ topic, startTime, durationMinutes, hostId, timezone }) {
    return this.api.meetings.create({ topic, startTime, durationMinutes, hostId, timezone });
  }

  async validateMeeting(meetingId) {
    return this.api.meetings.validate(meetingId);
  }

  async getNotes() {
    return this.api.workplace.notes.list();
  }

  async saveNote(payload) {
    return this.api.workplace.notes.create(payload);
  }

  async getMail() {
    return this.api.workplace.mail.list();
  }

  async sendMail({ subject, body, to }) {
    return this.api.workplace.mail.create({ subject, body, to });
  }

  async getCalendar() {
    return this.api.workplace.calendar.list();
  }

  async createCalendarItem(payload) {
    return this.api.workplace.calendar.create(payload);
  }
}

const createQorllaAppClient = (options) => new QorllaAppClient(options);

if (typeof module !== 'undefined') {
  module.exports = {
    QorllaAppClient,
    createQorllaAppClient
  };
}

if (typeof window !== 'undefined') {
  window.QorllaAppClient = QorllaAppClient;
  window.createQorllaAppClient = createQorllaAppClient;
}
