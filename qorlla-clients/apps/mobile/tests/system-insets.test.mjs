import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { patchMainActivity, MARK } = require('../plugins/with-system-insets.cjs');

// The app must never be drawn under the system navigation bar (Meet's control bar was half hidden on a Galaxy A03s and an LG LM-X320): the plugin pads the activity's content view natively.
const TEMPLATE = `package com.qorlla.mobile\n\nclass MainActivity : ReactActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    setTheme(R.style.AppTheme);\n    super.onCreate(null)\n  }\n}\n`;

test('the padding is added right after super.onCreate, once', () => {
  const out = patchMainActivity(TEMPLATE);
  assert.ok(out.includes(MARK) && out.indexOf('super.onCreate(null)') < out.indexOf('setOnApplyWindowInsetsListener'));
  assert.match(out, /Type\.navigationBars\(\)/); assert.match(out, /setPadding\(0, 0, 0, bars\.bottom\)/);
  assert.equal(patchMainActivity(out), out, 'idempotent');
});
test('a changed template is refused, not guessed at', () => { assert.throws(() => patchMainActivity('class MainActivity {}'), /refusing to guess/); });
test('the plugin is part of the app configuration and the Welcome screen no longer adds its own bottom margin', () => {
  assert.match(readFileSync(new URL('../app.config.js', import.meta.url), 'utf8'), /with-system-insets\.cjs/);
  assert.match(readFileSync(new URL('../src/WelcomeScreen.js', import.meta.url), 'utf8'), /const BOTTOM = 0;/);
});
