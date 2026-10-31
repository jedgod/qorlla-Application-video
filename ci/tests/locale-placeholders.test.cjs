'use strict';
// The sample addresses the UI prints (in every language) must use reserved documentation domains, so a Playwright report that captures them never needs a domain-wide exception in the scan allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DIR = path.join(__dirname, '..', '..', 'locales');
const RESERVED = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|org|net)$/i;

test('every address written in a locale file uses a reserved documentation domain', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')); assert.ok(files.length >= 3, 'the locale files were found');
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) assert.match(m[1], RESERVED, `${f}: an address uses a non-reserved domain (${m[1]})`);
  }
});
test('the localized sample line keeps its translated names and uses example.com', () => {
  const want = { 'es.js': 'nombre@example.com, otro@example.com', 'fr.js': 'nom@example.com, autre@example.com', 'pt-PT.js': 'nome@example.com, outro@example.com' };
  for (const [f, v] of Object.entries(want)) assert.ok(fs.readFileSync(path.join(DIR, f), 'utf8').includes(`"name@example.com, other@example.com": "${v}"`), f);
});
