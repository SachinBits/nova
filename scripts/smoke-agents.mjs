import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.env.HEX_TEST_URL || 'http://127.0.0.1:3000';
let cookie;
async function api(id, action) {
  const response = await fetch(root + '/api/arena' + (id && !action ? '?id=' + id : ''), {
    headers: { ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' },
    ...(action ? { method: 'POST', body: JSON.stringify({ id, action }) } : {}),
  });
  assert.ok(response.ok, String(response.status));
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  return (await response.json()).run;
}

async function waitFor(id, phase) {
  for (let i = 0; i < 80; i++) {
    const run = await api(id);
    assert.notEqual(run.phase, 'failed', run.messages.at(-1)?.text);
    if (run.phase === phase) return run;
    await sleep(200);
  }
  assert.fail('Timed out waiting for ' + phase);
}

const start = await api(undefined, 'start');
assert.ok(start.agentWork);
const waiting = await waitFor(start.id, 'approval');
assert.deepEqual(waiting.findings.map(({ id }) => id), ['prompt', 'sql', 'ownership']);
assert.equal(waiting.findings.find(({ id }) => id === 'ownership').replay, undefined);
assert.equal(waiting.findings.find(({ id }) => id === 'sql').state, 'Rolled back');
await api(start.id, 'approve');
const done = await waitFor(start.id, 'complete');
assert.equal(done.agentWork.decisions.length, 7);
assert.ok(done.findings.every(({ state, before, replay }) => state === 'Verified' && before.request === replay.request));
assert.ok(done.findings.find(({ id }) => id === 'sql').verification[0].control.status === 503);
assert.ok(done.messages.some(({ agent, status }) => agent === 'Verifier' && status === 'alert'));
console.log('Hex agent smoke test passed.');
