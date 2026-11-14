// Portal Chat rich text: the sanitizer is the only thing between one person's keystrokes and everyone else's screen. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, toPlain, hasMarkup, isSafeUrl, prepareBody } from '../server/chat/markup.mjs';

const ALLOWED = /^(?:[^<]|&(?:amp|lt|gt);|<\/?(?:b|i|u|s|ul|li|h2|h3|blockquote|fc-(?:red|orange|green|blue|purple|gray)|fs-(?:sm|lg|xl))>|<br>|<a href="https:\/\/[^"<>]*">|<\/a>)*$/;
const safe = (s) => { const out = sanitize(s); assert.ok(out === null || ALLOWED.test(out), 'unexpected output: ' + out); return out; };

test('formatting the page offers is kept', () => {
  assert.equal(safe('hello <b>bold</b> <i>it</i> <u>u</u> <s>s</s>'), 'hello <b>bold</b> <i>it</i> <u>u</u> <s>s</s>');
  assert.equal(safe('<ul><li>one</li><li>two</li></ul>'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(safe('<h2>Title</h2>x'), '<h2>Title</h2>x');
  assert.equal(safe('<strong>a</strong><em>b</em>'), '<b>a</b><i>b</i>');
});

test('script, handlers, images, frames and forms never survive', () => {
  for (const evil of [
    '<script>alert(1)</script>hi', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="https://evil.example"></iframe>x',
    '<b onclick="alert(1)">x</b>', '<style>body{display:none}</style>x', '<object data="x"></object>', '<form action="https://evil.example"><input></form>',
    '<a href="javascript:alert(1)">x</a>', '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>', '<a href="https://example.com" onmouseover="alert(1)">x</a>', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<<script>script>alert(1)<</script>/script>', '<b<script>>x', '<scr<script>ipt>alert(1)</scr</script>ipt>', '<!--><script>alert(1)</script>-->',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ]) {
    const out = safe(evil);
    assert.ok(!/<(script|img|svg|iframe|style|object|form|input|math)/i.test(out), evil + ' -> ' + out);
    assert.ok(!/<[^>]*\bon\w+\s*=/i.test(out), evil + ' -> ' + out);
    assert.ok(!/<a href="(?!https:)/i.test(out), evil + ' -> ' + out);
  }
  assert.equal(safe('<script>alert(1)</script>hi'), 'hi');
});

test('links: only https, no credentials, no extra attributes, quotes cannot break out', () => {
  assert.equal(safe('<a href="https://example.com/a?b=1&c=2" onclick="x()">ok</a>'), '<a href="https://example.com/a?b=1&amp;c=2">ok</a>');
  for (const bad of ['http://example.com', 'https://user:pw@evil.example/', 'https://localhost/', 'https://example.com/&quot; onclick=&quot;alert(1)', 'ftp://example.com']) assert.equal(safe(`<a href="${bad}">x</a>`), 'x', bad);
  assert.equal(isSafeUrl('https://example.com/ a'), null);
  assert.equal(isSafeUrl('https://' + 'a'.repeat(600) + '.com'), null);
});

test('text is escaped, entities cannot smuggle markup, odd nesting is repaired, odd characters are removed', () => {
  assert.equal(safe('1 < 2 && 3 > 2'), '1 &lt; 2 &amp;&amp; 3 &gt; 2');
  assert.equal(safe('&lt;script&gt;alert(1)&lt;/script&gt;'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(safe('&#60;script&#62;'), '&lt;script&gt;');
  assert.equal(safe('<b>unclosed <i>text'), '<b>unclosed <i>text</i></b>');
  assert.equal(safe('x</b></i>y'), 'xy');
  assert.equal(safe('<b><i>a</b>b</i>'), '<b><i>a</i></b>b');
  assert.equal(safe('a\u0000b‮c​d'), 'abcd');
  assert.equal(safe('<b>Important</b> agenda'), '<b>Important</b> agenda');
});

test('limits: depth, tag count and output size; non-strings are refused', () => {
  assert.ok((safe('<b>'.repeat(40) + 'x' + '</b>'.repeat(40)).match(/<b>/g) || []).length <= 8);
  assert.ok((safe('<b>x</b>'.repeat(500)).match(/<b>/g) || []).length <= 200);
  assert.equal(sanitize('x'.repeat(8001)), null);
  assert.equal(sanitize(42), null);
  assert.equal(sanitize(''), '');
});

test('plain text for search, export and the AI context; sanitizing is idempotent', () => {
  const c = safe('<h2>Plan</h2><ul><li>one</li><li>two &amp; three</li></ul>done<br>next');
  assert.equal(toPlain(c), 'Plan\n• one\n• two & three\ndone\nnext');
  assert.equal(hasMarkup('plain &amp; simple'), false); assert.equal(hasMarkup('<b>x</b>'), true);
  for (const s of ['<b>a</b> & <i>b</i>', '<a href="https://example.com/?a=1&b=2">x</a>', '<ul><li>1</li></ul>', 'x<br>y']) { const once = safe(s); assert.equal(safe(once), once); }
});

test('prepareBody: plain stays plain, markup-free rich becomes plain, empty and oversized are refused', () => {
  assert.deepEqual(prepareBody({ body: '  hi there ' }), { body: 'hi there', rich: null });
  assert.deepEqual(prepareBody({ rich: 'just <span>text</span>' }), { body: 'just text', rich: null });
  assert.deepEqual(prepareBody({ rich: '<b>x</b> <script>1</script>' }), { body: 'x', rich: '<b>x</b> ' });
  assert.equal(prepareBody({ body: '   ' }), null);
  assert.equal(prepareBody({ rich: '<b></b>' }), null);
  assert.equal(prepareBody({ rich: 'x'.repeat(9000) }), null);
  assert.equal(prepareBody({ body: 'x'.repeat(5000) }).body.length, 4000);
});

test('colour and size are a FIXED set: palette tags survive, arbitrary CSS and attributes never do', () => {
  assert.equal(safe('<fc-red>red</fc-red> <fs-xl>big</fs-xl>'), '<fc-red>red</fc-red> <fs-xl>big</fs-xl>');
  assert.equal(safe('<fc-red><fs-lg>both</fs-lg></fc-red>'), '<fc-red><fs-lg>both</fs-lg></fc-red>');
  assert.equal(safe('<fc-red onclick="x()" style="color:#000" class="y">z</fc-red>'), '<fc-red>z</fc-red>');                       // attributes on an allowed tag are dropped
  for (const evil of ['<span style="color:red;background:url(javascript:alert(1))">x</span>', '<font color="#d93025" size="6" onclick="x()">y</font>', '<fc-pink>p</fc-pink>', '<fs-9>q</fs-9>', '<fc-red/>',
    '<fc-red style="x">a</fc-red><div style="position:fixed">b</div>', '<p style="color:red">c</p>', '<fc-">d</fc->', '<fs-sm\n onclick=1>e</fs-sm>']) {
    const out = safe(evil); assert.ok(!/style|onclick|class=|color=|size=|font/i.test(out), evil + ' -> ' + out);
    assert.ok(!/<(span|font|p|div)/i.test(out), evil + ' -> ' + out);
  }
  assert.equal(safe('<span style="color:red">x</span>'), 'x'); assert.equal(safe('<fc-pink>p</fc-pink>'), 'p');
  assert.equal(safe('<h3>sub</h3><h1>H</h1>'), '<h3>sub</h3><h2>H</h2>');
  assert.equal(toPlain(safe('<h3>Sub</h3><fc-blue>x</fc-blue> y')), 'Sub\nx y'); assert.equal(hasMarkup('<fc-red>a</fc-red>'), true); assert.equal(hasMarkup('<fs-lg>a</fs-lg>'), true);
  assert.deepEqual(prepareBody({ rich: '<fc-green>ok</fc-green>' }), { body: 'ok', rich: '<fc-green>ok</fc-green>' });
  for (const s2 of ['<fc-red>a</fc-red>', '<fs-sm>b<fc-blue>c</fc-blue></fs-sm>']) { const once = safe(s2); assert.equal(safe(once), once); }
});
