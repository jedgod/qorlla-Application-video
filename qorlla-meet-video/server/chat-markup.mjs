// Loads the browser's rich-text module (public/chat-markup.js) so the server and the page run the SAME sanitizer. The package is "type":"module", so the UMD file is evaluated
// from source instead of being require()d.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'chat-markup.js');
const module_ = { exports: {} };
new Function('module', `${readFileSync(file, 'utf8')}\n//# sourceURL=chat-markup.js`)(module_);
export const { sanitize, toPlain, hasMarkup, isSafeUrl } = module_.exports;
