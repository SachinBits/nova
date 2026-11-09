import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { buffer } from 'node:stream/consumers';
import { fromBuffer } from 'yauzl';
import { ZipFile } from 'yazl';

const root = process.env.HEX_TEST_URL || 'http://127.0.0.1:3000';
const zip = new ZipFile();
zip.addBuffer(Buffer.from('{"type":"module","dependencies":{"next":"16.4.3"}}'), 'sample/package.json');
zip.addBuffer(Buffer.from('export default { poweredByHeader: true };\n'), 'sample/next.config.mjs');
zip.addBuffer(Buffer.from("import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport config from './next.config.mjs';\ntest('framework fingerprint disabled', () => assert.equal(config.poweredByHeader, false));\n"), 'sample/config.test.mjs');
zip.addBuffer(Buffer.from('FAKE_SECRET=fixture'), 'sample/.env');
const original = buffer(zip.outputStream);
zip.end();

async function submit(bytes) {
  return fetch(root + '/api/project-review', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', Origin: new URL(root).origin, 'Sec-Fetch-Site': 'same-origin' }, body: bytes,
  });
}

const input = await original;
const response = await submit(input);
const { report, archive, error } = await response.json();
assert.equal(response.status, 200, error);
assert.equal(report.framework, 'Next.js');
assert.equal(report.excludedFiles, 1);
assert.equal(report.findings[0].status, 'Patched');
assert.equal(report.changes[0].before, 'true');
assert.equal(report.changes[0].after, 'false');
assert.match(report.tests.baseline, /tests failed/);
assert.match(report.tests.patched, /1 Node test\(s\) completed/);

const unpacked = await promisify(fromBuffer)(Buffer.from(archive, 'base64'), { lazyEntries: true });
const files = new Map();
await new Promise((resolve, reject) => {
  unpacked.on('error', reject);
  unpacked.on('end', resolve);
  unpacked.on('entry', (entry) => {
    unpacked.openReadStream(entry, async (failure, stream) => {
      if (failure) return reject(failure);
      try {
        files.set(entry.fileName, (await buffer(stream)).toString());
        unpacked.readEntry();
      } catch (readError) {
        reject(readError);
      }
    });
  });
  unpacked.readEntry();
});
assert.match(files.get('sample/next.config.mjs'), /poweredByHeader: false/);
assert.equal(files.has('sample/.env'), false);
assert.equal(JSON.parse(files.get('HEX-REVIEW.json')).framework, 'Next.js');

const invalid = Buffer.from(input);
const originalName = Buffer.from('sample/package.json');
const traversal = Buffer.from('../bad/package.json');
assert.equal(traversal.length, originalName.length);
for (let offset = invalid.indexOf(originalName); offset !== -1; offset = invalid.indexOf(originalName, offset + traversal.length)) {
  traversal.copy(invalid, offset);
}
const rejected = await submit(invalid);
assert.equal(rejected.status, 400);
console.log('Hex project review smoke test passed.');
