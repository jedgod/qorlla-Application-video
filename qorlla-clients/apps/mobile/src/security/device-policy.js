import { parseJoinLink } from '../policy.js';
export const DEVICE_SCOPES = Object.freeze(['meetings:join', 'calls:receive', 'notifications:receive']);
export const validateDeepLink = parseJoinLink;
export function safeNotificationPayload(p) { if (!p || typeof p !== 'object') return null; if (!['incoming_call', 'ticket_update', 'meeting_invite'].includes(p.type)) return null; return { type: p.type, reference: String(p.reference || '').slice(0, 80) }; }
