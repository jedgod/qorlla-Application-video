/**
 * Canonical plan catalog and feature matrix.
 * metering: 'capacity' = snapshot limit (participants, storage allocation)
 *           'consumption' = metered usage that must be reserved atomically
 *           'none' = boolean flag
 */

export const PLAN_ORDER = ['basic', 'pro', 'business', 'enterprise'];

export const PLANS = {
  basic:      { code: 'basic',      displayName: 'Basic',      rank: 0 },
  pro:        { code: 'pro',        displayName: 'Pro',        rank: 10 },
  business:   { code: 'business',   displayName: 'Business',   rank: 20 },
  enterprise: { code: 'enterprise', displayName: 'Enterprise', rank: 30 },
};

export const FEATURES = {
  // Meetings — capacity
  'meetings.host':                 { type: 'boolean',  category: 'meetings', metering: 'none',        description: 'Host a meeting' },
  'meetings.duration_minutes':     { type: 'numeric',  category: 'meetings', metering: 'capacity',    description: 'Max meeting duration (minutes)' },
  'meetings.participants':         { type: 'numeric',  category: 'meetings', metering: 'capacity',    description: 'Max participants per meeting' },
  'meetings.cloud_recording':      { type: 'boolean',  category: 'meetings', metering: 'none',        description: 'Cloud recording' },
  'meetings.webinar_mode':         { type: 'boolean',  category: 'meetings', metering: 'none',        description: 'Webinar mode' },
  'meetings.breakout_rooms':       { type: 'boolean',  category: 'meetings', metering: 'none',        description: 'Breakout rooms' },

  // AI — consumption
  'ai.meeting_summaries':          { type: 'numeric',  category: 'ai',       metering: 'consumption', period: 'billing', description: 'AI meeting summaries' },
  'ai.queries':                    { type: 'numeric',  category: 'ai',       metering: 'consumption', period: 'billing', description: 'AI queries' },
  'ai.in_meeting_questions':       { type: 'boolean',  category: 'ai',       metering: 'none',        description: 'In-meeting AI questions' },
  'ai.custom_summary_templates':   { type: 'numeric',  category: 'ai',       metering: 'consumption', period: 'billing', description: 'Custom summary templates' },
  'ai.agentic_search':             { type: 'boolean',  category: 'ai',       metering: 'none',        description: 'Agentic search' },
  'ai.workflows':                  { type: 'boolean',  category: 'ai',       metering: 'none',        description: 'Workflows' },

  // Notes & productivity
  'notes.ai_note_taking':          { type: 'numeric',  category: 'notes',    metering: 'consumption', period: 'billing', description: 'AI note-taking uses' },
  'whiteboard.editable':           { type: 'numeric',  category: 'whiteboard', metering: 'capacity',  description: 'Editable whiteboards' },
  'clips.create':                  { type: 'numeric',  category: 'clips',    metering: 'consumption', period: 'billing', description: 'Clips created' },
  'clips.custom_avatars_minutes':  { type: 'numeric',  category: 'clips',    metering: 'consumption', period: 'billing', description: 'Custom avatar minutes' },
  'canvas.ai_docs':                { type: 'numeric',  category: 'canvas',   metering: 'consumption', period: 'billing', description: 'AI document creations' },

  // Storage & collaboration
  'storage.cloud_gb':              { type: 'numeric',  category: 'storage',  metering: 'capacity',    description: 'Cloud storage allocation (GB)' },
  'mail.qorlla':                   { type: 'boolean',  category: 'mail',     metering: 'none',        description: 'Qorlla Mail' },
  'calendar.qorlla':               { type: 'boolean',  category: 'calendar', metering: 'none',        description: 'Qorlla Calendar' },
  'chat.instant':                  { type: 'boolean',  category: 'chat',     metering: 'none',        description: 'Instant messaging' },
  'phone.voip':                    { type: 'boolean',  category: 'phone',    metering: 'none',        description: 'Internal VoIP / extension calling' },
  'phone.pstn':                    { type: 'boolean',  category: 'phone',    metering: 'none',        description: 'PSTN / public telephone numbers' },

  // Admin & compliance
  'admin.sso':                     { type: 'boolean',  category: 'admin',    metering: 'none',        description: 'SSO / SAML' },
  'admin.advanced_analytics':      { type: 'boolean',  category: 'admin',    metering: 'none',        description: 'Advanced analytics' },
  'admin.custom_branding':         { type: 'boolean',  category: 'admin',    metering: 'none',        description: 'Custom branding' },
  'admin.dedicated_support':       { type: 'boolean',  category: 'admin',    metering: 'none',        description: 'Dedicated support' },
  'compliance.hipaa':              { type: 'boolean',  category: 'compliance', metering: 'none',      description: 'HIPAA-ready' },
  'compliance.soc2':               { type: 'boolean',  category: 'compliance', metering: 'none',      description: 'SOC 2' },

  // Support
  'support.priority':              { type: 'boolean',  category: 'support',  metering: 'none',        description: 'Priority support' },
};

export const PLAN_ENTITLEMENTS = {
  basic: {
    'meetings.host': true,
    'meetings.duration_minutes': 40,
    'meetings.participants': 100,
    'meetings.cloud_recording': false,
    'meetings.webinar_mode': false,
    'meetings.breakout_rooms': false,
    'ai.meeting_summaries': 3,
    'ai.queries': 20,
    'ai.in_meeting_questions': false,
    'ai.custom_summary_templates': 0,
    'ai.agentic_search': false,
    'ai.workflows': false,
    'notes.ai_note_taking': 3,
    'whiteboard.editable': 3,
    'clips.create': 5,
    'clips.custom_avatars_minutes': 0,
    'canvas.ai_docs': 3,
    'storage.cloud_gb': 0,
    'mail.qorlla': false,
    'calendar.qorlla': false,
    'chat.instant': true,
    'phone.voip': true,
    'phone.pstn': false,
    'admin.sso': false,
    'admin.advanced_analytics': false,
    'admin.custom_branding': false,
    'admin.dedicated_support': false,
    'compliance.hipaa': false,
    'compliance.soc2': false,
    'support.priority': false,
  },
  pro: {
    'meetings.duration_minutes': 1800,
    'meetings.cloud_recording': true,
    'meetings.breakout_rooms': true,
    'ai.meeting_summaries': 'unlimited',
    'ai.queries': 'unlimited',
    'ai.in_meeting_questions': true,
    'ai.custom_summary_templates': 8,
    'ai.agentic_search': true,
    'ai.workflows': true,
    'notes.ai_note_taking': 'unlimited',
    'whiteboard.editable': 'unlimited',
    'clips.create': 'unlimited',
    'clips.custom_avatars_minutes': 3,
    'canvas.ai_docs': 'unlimited',
    'storage.cloud_gb': 10,
    'mail.qorlla': true,
    'calendar.qorlla': true,
    'support.priority': true,
  },
  business: {
    'meetings.participants': 300,
    'meetings.duration_minutes': 'unlimited',
    'meetings.webinar_mode': true,
    'ai.custom_summary_templates': 'unlimited',
    'clips.custom_avatars_minutes': 10,
    'storage.cloud_gb': 50,
    'admin.sso': true,
    'admin.advanced_analytics': true,
    'phone.pstn': true,
  },
  enterprise: {
    'meetings.participants': 1000,
    'storage.cloud_gb': 500,
    'admin.custom_branding': true,
    'admin.dedicated_support': true,
    'compliance.hipaa': true,
    'compliance.soc2': true,
  },
};

export function resolveEntitlements(planCode) {
  const idx = PLAN_ORDER.indexOf(planCode);
  if (idx === -1) return {};
  const resolved = {};
  for (let i = 0; i <= idx; i++) {
    Object.assign(resolved, PLAN_ENTITLEMENTS[PLAN_ORDER[i]] || {});
  }
  return resolved;
}

export function minimumPlanFor(featureKey) {
  for (const plan of PLAN_ORDER) {
    const v = resolveEntitlements(plan)[featureKey];
    if (v === true || v === 'unlimited' || (typeof v === 'number' && v > 0)) return plan;
  }
  return null;
}

export function isValidPlan(code) {
  return PLAN_ORDER.includes(code);
}

export function isValidFeature(key) {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}

export function getFeatureMeta(key) {
  return FEATURES[key] || null;
}
