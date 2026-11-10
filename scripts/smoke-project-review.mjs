import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { buffer } from 'node:stream/consumers';
import { fromBuffer } from 'yauzl';
import { ZipFile } from 'yazl';

const root = process.env.HEX_TEST_URL || 'http://127.0.0.1:3000';

async function submit(bytes) {
  return fetch(root + '/api/project-review', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', Origin: new URL(root).origin, 'Sec-Fetch-Site': 'same-origin' }, body: bytes,
  });
}

async function unpack(archive) {
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
  return files;
}

const input = await readFile(new URL('../hex-sample-store.zip', import.meta.url));
const response = await submit(input);
const { report, archive, error } = await response.json();
assert.equal(response.status, 200, error);
assert.ok(report.findings.length >= 8, 'Expected at least 8 findings, got ' + report.findings.length);
assert.ok(report.findings.every(({ severity, cwe }) => severity && cwe));
const sql = report.findings.find(({ title }) => title === 'Interpolated SQL');
assert.equal(sql?.status, 'Patched');
assert.equal(sql.detail, 'Rewrote to bound parameters.');
assert.equal(sql.verification, 'test-verified');
assert.equal(report.findings.filter(({ status }) => status === 'Patched').length, 2);
assert.equal(report.tests.baseline.fail, 1);
assert.equal(report.tests.baseline.pass, 5);
assert.equal(report.tests.patched.fail, 0);
assert.equal(report.tests.patched.pass, 6);
assert.equal(report.tests.patched.jsChecked, 5);
assert.equal(report.tsChecked, 0);

const files = await unpack(archive);
assert.match(files.get('hex-sample-store/next.config.mjs'), /poweredByHeader: false/);
assert.match(files.get('hex-sample-store/store.mjs'), /prepare\('SELECT name, email FROM customers WHERE name = \?'\)\.all\(name\)/);
assert.equal(JSON.parse(files.get('HEX-REVIEW.json')).tests.patched.pass, 6);

const credentials = new ZipFile();
credentials.addBuffer(Buffer.from('{"name":"fixture"}'), 'sample/package.json');
credentials.addBuffer(Buffer.from('export default {};\n'), 'sample/index.mjs');
credentials.addBuffer(Buffer.from('FAKE_SECRET=fixture'), 'sample/.env');
const pending = buffer(credentials.outputStream);
credentials.end();
const excluded = await (await submit(await pending)).json();
assert.equal(excluded.report.excludedFiles, 1, excluded.error);
assert.equal((await unpack(excluded.archive)).has('sample/.env'), false);

const invalid = Buffer.from(input);
const originalName = Buffer.from('hex-sample-store/package.json');
const traversal = Buffer.from('../-sample-store/package.json');
assert.equal(traversal.length, originalName.length);
for (let offset = invalid.indexOf(originalName); offset !== -1; offset = invalid.indexOf(originalName, offset + traversal.length)) {
  traversal.copy(invalid, offset);
}
const rejected = await submit(invalid);
assert.equal(rejected.status, 400);
console.log('Hex project review smoke test passed.');
