// Self-host Tesseract.js worker, WASM cores and English model (no CDN at runtime).
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nm = join(here, '..', 'node_modules');
const out = join(here, '..', '..', 'public', 'vendor', 'tesseract');
mkdirSync(join(out, 'lang'), { recursive: true });

copyFileSync(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
for (const f of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
  'tesseract-core-simd-lstm.wasm',
]) {
  copyFileSync(join(nm, 'tesseract.js-core', f), join(out, f));
}
// Stored uncompressed: some Apache setups add Content-Encoding to .gz files,
// which would make the browser decompress twice.
const gz = join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz');
if (!existsSync(gz)) throw new Error('missing ' + gz);
writeFileSync(join(out, 'lang', 'eng.traineddata'), gunzipSync(readFileSync(gz)));
console.log('OCR assets copied to', out);
