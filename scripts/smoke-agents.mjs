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
  for (let i = 0; i < 120; i++) {
    const run = await api(id);
    assert.notEqual(run.phase, 'failed', run.messages.at(-1)?.text);
    if (run.phase === phase) return run;
    await sleep(200);
  }
  assert.fail('Timed out waiting for ' + phase);
}

const start = await api(undefined, 'start');
assert.ok(start.agentWork, 'agent mode should be active with a key');

const waiting = await waitFor(start.id, 'approval');
assert.ok(waiting.aiCalls <= 12, 'AI calls per run must stay within budget: ' + waiting.aiCalls);
assert.equal(waiting.findings.length, 6, 'all six probes confirm an exposure');
const sql = waiting.findings.find(({ id }) => id === 'sql');
assert.equal(sql.state, 'Verified', 'the scoped SQL fix should survive the re-attack');
assert.ok(sql.payload, 'the SQL finding records the payload that worked');
const attempts = sql.attacks.filter((a) => a.kind === 'attempt');
const reattacks = sql.attacks.filter((a) => a.kind === 'reattack');
assert.ok(attempts.length >= 1 && attempts.some((a) => a.outcome === 'leaked'), 'at least one attempt leaked');
assert.equal(reattacks.length, 2, 'exactly two re-attacks');
assert.ok(reattacks.every((a) => a.outcome === 'blocked'), 'every re-attack must be blocked');
assert.equal(waiting.findings.find(({ id }) => id === 'prompt').state, 'Verified');
assert.equal(waiting.findings.find(({ id }) => id === 'ownership').state, 'Open');
assert.ok(waiting.messages.some((m) => /^Attempt 1:/.test(m.text) && m.source === 'OpenAI'), 'attempt message with OpenAI source');
assert.ok(waiting.messages.some((m) => m.text === 'Red re-attacked with 2 new payloads: all blocked.'));
assert.ok(waiting.messages.some((m) => m.text.includes('deterministic fixture')), 'prompt endpoint labelled as a deterministic fixture');
assert.ok(waiting.messages.some(({ agent, status }) => agent === 'Verifier' && status === 'alert'), 'a broad quarantine was rolled back');

await api(start.id, 'approve');
const done = await waitFor(start.id, 'complete');
assert.ok(done.aiCalls <= 12, 'AI calls still within budget after approval: ' + done.aiCalls);
assert.ok(done.findings.every(({ state }) => state === 'Verified'), 'every finding is verified after approval');
assert.equal(done.findings.find(({ id }) => id === 'ownership').replay.status, 404);

const receipt = await fetch(root + '/api/arena?id=' + start.id + '&receipt=1', { headers: { cookie } });
const { evidence } = await receipt.json();
assert.ok(evidence.attacks.length >= 3, 'the receipt carries the attack log');
console.log('Hex agent smoke test passed.');
