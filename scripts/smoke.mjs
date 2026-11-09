import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.env.HEX_TEST_URL || 'http://127.0.0.1:3000';
let cookie = '';

async function api({ id, action, message, receipt, anonymous } = {}) {
  const query = new URLSearchParams();
  if (id && !action) query.set('id', id);
  if (receipt) query.set('receipt', '1');
  const response = await fetch(root + '/api/arena?' + query, {
    headers: {
      ...(cookie && !anonymous ? { cookie } : {}),
      ...(action ? { 'Content-Type': 'application/json', Origin: new URL(root).origin, 'Sec-Fetch-Site': 'same-origin' } : {}),
    },
    ...(action ? { method: 'POST', body: JSON.stringify({ id, action, message }) } : {}),
  });
  const owner = response.headers.get('set-cookie');
  if (owner) cookie = owner.split(';')[0];
  const body = await response.json();
  if (anonymous) {
    assert.equal(response.status, 404);
    return;
  }
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}

async function waitForApproval(id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { run } = await api({ id });
    if (run.phase === 'approval') return run;
    assert.equal(run.phase, 'running');
    await sleep(250);
  }
  assert.fail('Run did not reach approval');
}

const crossOrigin = await fetch(root + '/api/arena', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' },
  body: JSON.stringify({ action: 'start' }),
});
assert.equal(crossOrigin.status, 403);
const sameSite = await fetch(root + '/api/arena', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: new URL(root).origin, 'Sec-Fetch-Site': 'same-site' },
  body: JSON.stringify({ action: 'start' }),
});
assert.equal(sameSite.status, 403);

const { run: first } = await api({ action: 'start' });
const id = first.id;
const { run: paused } = await api({ id, action: 'pause' });
assert.equal(paused.phase, 'paused');
await sleep(1050);
assert.equal((await api({ id })).run.step, paused.step);
await api({ id, action: 'resume' });

const approval = await waitForApproval(id);
assert.equal(approval.attempts, 3);
assert.equal(approval.findings.length, 3);
assert.equal(approval.findings.filter((item) => item.state === 'Verified').length, 2);
assert.match(approval.messages.find((message) => message.agent === 'IDOR Runner').text, /discovered by Injector/);
const { run: approved } = await api({ id, action: 'approve' });
assert.equal(approved.phase, 'complete');
assert.equal(approved.approved, true);
assert.ok(approved.findings.every((item) => item.state === 'Verified' && item.control.status === 200));
const orders = approved.findings.find((item) => item.id === 'ownership');
assert.equal(orders.before.response.order.owner, 'bob');
assert.equal(orders.replay.status, 404);
assert.equal(orders.control.response.order.owner, 'alice');

const { run: duplicate } = await api({ id, action: 'approve' });
assert.equal(duplicate.messages.filter((message) => message.text === 'Apply the order ownership policy.').length, 1);
const { run: directive } = await api({ id, action: 'directive', message: 'Summarize this exercise.' });
assert.equal(directive.messages.at(-1).agent, 'Director');
const { evidence, sha256 } = await api({ id, receipt: true });
assert.equal(sha256, createHash('sha256').update(JSON.stringify(evidence)).digest('hex'));
await api({ id, anonymous: true });

const { run: second } = await api({ action: 'start' });
await waitForApproval(second.id);
const { run: declined, runs } = await api({ id: second.id, action: 'decline' });
assert.equal(declined.phase, 'complete');
assert.equal(declined.approved, false);
assert.equal(declined.findings.find((item) => item.id === 'ownership').state, 'Open');
assert.ok(runs.some((run) => run.id === id));
assert.equal((await api({ id })).run.approved, true);
console.log('Hex smoke test passed.');
