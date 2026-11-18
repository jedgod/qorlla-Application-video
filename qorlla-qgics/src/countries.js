// Private namespace. Codes reflect calling-code geography but numbers are NOT E.164 PSTN allocations.
export const COUNTRY_CODES = Object.freeze({
 US:'1', CA:'1', GH:'233', GB:'44', NG:'234', IN:'91', DE:'49', FR:'33',
 ZA:'27', KE:'254', AU:'61', NZ:'64', JP:'81', BR:'55', MX:'52',
 AE:'971', SG:'65', NL:'31', IT:'39', ES:'34', PK:'92', BD:'880'
});
export function normalizeEmail(email) {
 if (typeof email !== 'string') throw new Error('invalid_email');
 const e=email.trim().toLowerCase();
 if (e.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('invalid_email');
 return e;
}
export function normalizeNumber(input) {
 if(typeof input!=='string') throw new Error('invalid_number');
 const cleaned=input.replace(/[\s().-]/g,'');
 if(!/^\+[0-9]{7,20}$/.test(cleaned)) throw new Error('invalid_number');
 return cleaned;
}
export function issueNumber(country,serial) {
 const iso=String(country).toUpperCase();
 const code=COUNTRY_CODES[iso];
 if(!code || !Number.isSafeInteger(serial) || serial<1 || serial>999999999999) throw new Error('invalid_allocation');
 // Country ISO is part of the allocation key, not the displayed identifier.
 // Distinct countries sharing a calling code need disjoint serial ranges.
 const sharedCodeOffset = iso==='CA' ? 500000000000 : 0;
 const value=serial+sharedCodeOffset;
 if(value>999999999999) throw new Error('allocation_exhausted');
 return '+'+code+String(value).padStart(12,'0');
}
