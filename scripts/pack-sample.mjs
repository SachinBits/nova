import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buffer } from 'node:stream/consumers';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'samples', 'atlas-store');
const zip = new ZipFile();
// A fixed timestamp keeps the archive byte-identical between rebuilds.
const mtime = new Date('2026-01-01T00:00:00Z');
const names = readdirSync(source, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort();
const collected = buffer(zip.outputStream);
for (const name of names) zip.addBuffer(readFileSync(join(source, name)), 'hex-sample-store/' + name, { mtime });
zip.end();
const bytes = await collected;
// The repo-root copy feeds the smoke tests; the public copy is fetched by the landing page's one-click sample.
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'hex-sample-store.zip'), bytes);
writeFileSync(join(root, 'public', 'hex-sample-store.zip'), bytes);
console.log('Packed ' + names.length + ' files into hex-sample-store.zip and public/hex-sample-store.zip.');
