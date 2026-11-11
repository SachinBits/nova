import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buffer } from 'node:stream/consumers';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const root = fileURLToPath(new URL('../', import.meta.url));
// A fixed timestamp keeps each archive byte-identical between rebuilds.
const mtime = new Date('2026-01-01T00:00:00Z');

async function pack(sampleDir, zipName, prefix) {
  const source = join(root, 'samples', sampleDir);
  const zip = new ZipFile();
  const collected = buffer(zip.outputStream);
  const names = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(source, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
  for (const name of names) zip.addBuffer(readFileSync(join(source, name)), prefix + name, { mtime });
  zip.end();
  const bytes = await collected;
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public', zipName), bytes);
  console.log('Packed ' + names.length + ' files into public/' + zipName + '.');
}

// The JS/TS sample is wrapped in a named directory; the Python sample is flat so imports resolve.
await pack('atlas-store', 'hex-sample-store.zip', 'hex-sample-store/');
await pack('field-supply-py', 'field-supply-py.zip', '');
