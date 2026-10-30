// Dial classification and country-aware internal aliases (A3.7). Pure classification here; the alias authority is the PostgreSQL table voice_country_aliases (sql/017), an index onto the globally unique extension.
// Nothing in this file can place a call, reach a carrier, quote a price or touch a wallet: a "+" destination is only ever classified (and then refused as PSTN by the caller of this module).
import { randomInt } from 'node:crypto';
import { EMERGENCY_NUMBERS } from './core.mjs';

export class AliasError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

/** What the user typed -> what it is. Formatting characters (space, dot, dash, parentheses) are ignored; nothing else is guessed:
 *  "+" + 7-15 digits is an EXTERNAL REQUEST (never routed here); "00..." is INVALID (it is never silently turned into "+"); 3-8 digits is an extension; 9-15 digits is an internal alias lookup;
 *  an emergency number is its own kind (Qorlla never places emergency calls). */
export function classifyDial(raw) {
  if (typeof raw !== 'string' || raw.length > 40) return { kind: 'INVALID', reason: 'Enter a Qorlla extension, a Qorlla number, or +country code' };
  const value = raw.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('+')) return /^\+[1-9][0-9]{6,14}$/.test(value) ? { kind: 'EXTERNAL_REQUEST', e164: value } : { kind: 'INVALID', reason: 'Invalid international format' };
  if (!/^[0-9]+$/.test(value)) return { kind: 'INVALID', reason: 'Use digits only (or +country code)' };
  if (EMERGENCY_NUMBERS.has(value)) return { kind: 'EMERGENCY', digits: value };                       // before the "00" rule: 000 is an emergency number
  if (value.startsWith('00')) return { kind: 'INVALID', reason: 'Use +country code for international numbers' };
  if (/^[0-9]{3,8}$/.test(value)) return { kind: 'INTERNAL_EXTENSION', extension: value };
  if (/^[0-9]{9,15}$/.test(value)) return { kind: 'INTERNAL_ALIAS', national: value };
  return { kind: 'INVALID', reason: 'That is not a Qorlla extension or number' };
}

/** VOICE_ALIAS_NAMESPACES = {"GB":{"prefix":"...","length":11}, ...}: for each country the OPERATOR-APPROVED reserved range that aliases are drawn from. There is NO default: a country that is not configured
 *  cannot get aliases (fail closed). The operator is responsible for the range being reserved/unallocated (a national-shaped alias must never equal a real public number). */
export function parseNamespaces(env = process.env) {
  const out = new Map(); if (!env.VOICE_ALIAS_NAMESPACES) return out;
  let cfg; try { cfg = JSON.parse(env.VOICE_ALIAS_NAMESPACES); } catch { throw new Error('VOICE_ALIAS_NAMESPACES is not valid JSON'); }
  const minRandom = Number(env.VOICE_ALIAS_MIN_RANDOM_DIGITS || 4);
  for (const [iso, v] of Object.entries(cfg || {})) {
    if (!/^[A-Z]{2}$/.test(iso) || !v || !/^[0-9]{1,12}$/.test(String(v.prefix)) || !Number.isInteger(v.length) || v.length < 9 || v.length > 15) throw new Error('VOICE_ALIAS_NAMESPACES: bad entry for ' + iso);
    if (v.length - String(v.prefix).length < minRandom) throw new Error('VOICE_ALIAS_NAMESPACES: ' + iso + ' leaves fewer than ' + minRandom + ' random digits');
    out.set(iso, { prefix: String(v.prefix), length: v.length });
  }
  return out;
}
export function formatNational(iso, digits) {
  if ((iso === 'US' || iso === 'CA') && digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits.replace(/(?=(\d{4})+$)/g, ' ').trim();
}

const COLS = 'alias_id, account_id, extension, iso_country, canonical_national, display_national, status, issued_at, retired_at';
const view = (r) => (r ? { country: r.iso_country, display: r.display_national, number: r.canonical_national, extension: r.extension, status: r.status, issuedAt: r.issued_at, qorllaOnly: true } : null);

export function createAliases({ store, env = process.env }) {
  const { tx } = store, namespaces = parseNamespaces(env);
  const audit = (c, actor, action, reason, ctx) => c.query("INSERT INTO shield_events(actor, action, decision, reason, context) VALUES($1,$2,'ALLOW',$3,$4)", [actor, action, reason, JSON.stringify(ctx)]);
  const lock = (c, account) => c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['alias:' + account]);

  /** Idempotent, atomic, race-safe: one active alias per account, globally unique digits, never reused. Needs an EXPLICIT confirmation of the country; the country is never inferred. */
  async function assign(account, { country, confirm }) {
    if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) throw new AliasError('invalid_input');
    if (confirm !== true) throw new AliasError('confirmation_required');
    const ns = namespaces.get(country); if (!ns) throw new AliasError('country_not_available', 404);
    return tx(async (c) => {
      await lock(c, account);
      const id = (await c.query('SELECT extension, enabled FROM voice_identities WHERE account_id=$1', [account])).rows[0]; if (!id || !id.enabled) throw new AliasError('caller_disabled', 403);
      const cur = (await c.query('SELECT ' + COLS + ' FROM voice_country_aliases WHERE account_id=$1 AND status=\'active\'', [account])).rows[0];
      if (cur) { if (cur.iso_country !== country) throw new AliasError('alias_country_mismatch', 409); return { alias: view(cur), reused: true }; }       // a country change is an explicit procedure (administrator retires the alias first), never automatic
      await c.query('INSERT INTO voice_country_confirmations(account_id, iso_country) VALUES($1,$2) ON CONFLICT (account_id) DO UPDATE SET iso_country=$2, confirmed_at=now(), confirmations = voice_country_confirmations.confirmations + 1', [account, country]);
      const randomDigits = ns.length - ns.prefix.length;
      for (let i = 0; i < 40; i++) {
        let digits = ns.prefix; for (let k = 0; k < randomDigits; k++) digits += String(randomInt(0, 10));
        const row = (await c.query('INSERT INTO voice_country_aliases(account_id, extension, iso_country, canonical_national, display_national) VALUES($1,$2,$3,$4,$5) ON CONFLICT (canonical_national) DO NOTHING RETURNING ' + COLS, [account, id.extension, country, digits, formatNational(country, digits)])).rows[0];
        if (row) { await audit(c, account, 'alias.assign', country, { discriminator: country, tenant: null }); return { alias: view(row), reused: false }; }
      }
      throw new AliasError('alias_capacity', 503);                                       // the reserved range is used up (retired numbers count): never reuse, tell the operator
    });
  }
  async function get(account) {
    const r = await tx(async (c) => ({ alias: (await c.query('SELECT ' + COLS + ' FROM voice_country_aliases WHERE account_id=$1 AND status=\'active\'', [account])).rows[0], conf: (await c.query('SELECT iso_country FROM voice_country_confirmations WHERE account_id=$1', [account])).rows[0] }));
    return { alias: view(r.alias), confirmedCountry: r.conf ? r.conf.iso_country : null, countries: [...namespaces.keys()].sort() };
  }
  /** The extension behind an alias, for THIS caller: same confirmed country only, active aliases only. Every miss looks the same. */
  async function resolve(caller, canonical) {
    const row = (await tx((c) => c.query("SELECT a.extension, a.account_id FROM voice_country_aliases a JOIN voice_country_confirmations f ON f.account_id=$1 AND f.iso_country=a.iso_country WHERE a.canonical_national=$2 AND a.status='active'", [caller, canonical]))).rows[0];
    return row ? { extension: row.extension, accountId: row.account_id } : null;
  }
  /** Explicit change procedure: an administrator retires the alias (kept forever, never reissued); the account may then confirm a country again and receive a NEW number. */
  async function retire(account, { reason, actor }) {
    if (typeof reason !== 'string' || reason.length < 3 || reason.length > 200) throw new AliasError('invalid_input');
    return tx(async (c) => {
      await lock(c, account);
      const r = (await c.query("UPDATE voice_country_aliases SET status='retired', retired_at=now(), retired_by=$2, retire_reason=$3 WHERE account_id=$1 AND status='active' RETURNING " + COLS, [account, String(actor || 'admin').slice(0, 128), reason])).rows[0];
      if (!r) throw new AliasError('no_active_alias', 404);
      await audit(c, String(actor || 'admin'), 'alias.retire', reason.slice(0, 80), { discriminator: account }); return { alias: view(r) };
    });
  }
  return { namespaces, assign, get, resolve, retire };
}
