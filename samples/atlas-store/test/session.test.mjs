import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession } from '../session.mjs';

test('issues a non-empty session token', () => {
  const token = issueSession();
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
});
