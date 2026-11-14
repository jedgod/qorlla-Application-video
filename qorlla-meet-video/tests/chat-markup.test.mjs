// Meeting chat rich text: the sanitizer is the only thing between a participant's keystrokes and every other participant's screen. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, toPlain, hasMarkup, isSafeUrl } from '../server/chat-markup.mjs';

const ALLOWED = /^(?:[^<]|&(?:amp|lt|gt);|<\/?(?:b|i|u|s|ul|li|h2|blockquote)>|<br>|<a href="https:\/\/[^"<>]*">|<\/a>)*$/;
const safe = (s) => { const out = sanitize(s); assert.ok(out === null || ALLOWED.test(out), 'unexpected output: ' + out); return out; };

test('formatting the page offers is kept', () => {
  assert.equal(safe('hello <b>bold</b> <i>it</i> <u>u</u> <s>s</s>'), 'hello <b>bold</b> <i>it</i> <u>u</u> <s>s</s>');
  assert.equal(safe('<ul><li>one</li><li>two</li></ul>'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(safe('<h2>Title</h2>x'), '<h2>Title</h2>x');
  assert.equal(safe('<strong>a</strong><em>b</em>'), '<b>a</b><i>b</i>');
});

test('script, handlers, images and frames never survive', () => {
  for (const evil of [
    '<script>alert(1)</script>hi', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="https://evil.example"></iframe>x',
    '<b onclick="alert(1)">x</b>', '<style>body{display:none}</style>x', '<object data="x"></object>', '<form action="https://evil.example"><input></form>',
    '<a href="javascript:alert(1)">x</a>', '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>', '<a href="https://example.com" onmouseover="alert(1)">x</a>', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<<script>script>alert(1)<</script>/script>', '<b<script>>x', '<scr<script>ipt>alert(1)</scr</script>ipt>', '<!--><script>alert(1)</script>-->', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ]) {
    const out = safe(evil);
    assert.ok(!/<(script|img|svg|iframe|style|object|form|input|math)/i.test(out), evil + ' -> ' + out);
    assert.ok(!/\bon\w+=/i.test(out.replace(/&[a-z]+;/g, '')) || !/<[^>]*\bon\w+=/i.test(out), evil + ' -> ' + out);
    assert.ok(!/javascript:/i.test(out.replace(/<a href="https:[^"]*">/g, '')) || !/href="javascript/i.test(out), evil + ' -> ' + out);
  }
  assert.equal(safe('<script>alert(1)</script>hi'), 'hi');
});

test('links: only https, no credentials, no extra attributes, quotes cannot break out', () => {
  assert.equal(safe('<a href="https://example.com/a?b=1&c=2" onclick="x()">ok</a>'), '<a href="https://example.com/a?b=1&amp;c=2">ok</a>');
  assert.equal(safe('<a href="http://example.com">x</a>'), 'x');
  assert.equal(safe('<a href="https://user:pw@evil.example/">x</a>'), 'x');
  assert.equal(safe('<a href="https://localhost/">x</a>'), 'x');
  assert.equal(safe('<a href="https://example.com/&quot; onclick=&quot;alert(1)">x</a>'), 'x');
  assert.equal(isSafeUrl('https://example.com/ a'), null);
  assert.equal(isSafeUrl('https://' + 'a'.repeat(600) + '.com'), null);
  assert.equal(isSafeUrl('ftp://example.com'), null);
});

test('text is escaped, entities cannot smuggle markup, odd nesting is repaired', () => {
  assert.equal(safe('1 < 2 && 3 > 2'), '1 &lt; 2 &amp;&amp; 3 &gt; 2');
  assert.equal(safe('&lt;script&gt;alert(1)&lt;/script&gt;'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(safe('&#60;script&#62;'), '&lt;script&gt;');
  assert.equal(safe('<b>unclosed <i>text'), '<b>unclosed <i>text</i></b>');
  assert.equal(safe('x</b></i>y'), 'xy');
  assert.equal(safe('<b><i>a</b>b</i>'), '<b><i>a</i></b>b');
});

test('control characters and bidi overrides are removed', () => {
  assert.equal(safe('a\u0000b‮c​d'), 'abcd');
  assert.equal(safe('&#0;&#8238;x'), 'x');
});

test('limits: depth, tag count and output size', () => {
  const deep = safe('<b>'.repeat(40) + 'x' + '</b>'.repeat(40));
  assert.ok((deep.match(/<b>/g) || []).length <= 8);
  const many = safe('<b>x</b>'.repeat(500));
  assert.ok((many.match(/<b>/g) || []).length <= 200);
  assert.equal(sanitize('x'.repeat(8001)), null);
  assert.equal(sanitize(42), null);
  assert.equal(sanitize(''), '');
});

test('plain text for exports and the AI summary', () => {
  const c = safe('<h2>Plan</h2><ul><li>one</li><li>two &amp; three</li></ul>done<br>next');
  assert.equal(toPlain(c), 'Plan\n• one\n• two & three\ndone\nnext');
  assert.equal(toPlain('1 &lt; 2'), '1 < 2');
  assert.equal(hasMarkup('plain &amp; simple'), false);
  assert.equal(hasMarkup('<b>x</b>'), true);
});

test('sanitizing is idempotent', () => {
  for (const s of ['<b>a</b> & <i>b</i>', '<a href="https://example.com/?a=1&b=2">x</a>', '<ul><li>1</li></ul>', 'x<br>y']) {
    const once = safe(s); assert.equal(safe(once), once);
  }
});

test('non-breaking spaces (what a browser inserts after a formatting change) become normal spaces', () => {
  assert.equal(safe('<b>Important</b>\u00A0agenda'), '<b>Important</b> agenda');
  assert.equal(safe('a&nbsp;b'), 'a b');
});
