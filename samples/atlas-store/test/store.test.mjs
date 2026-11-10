import test from 'node:test';
import assert from 'node:assert/strict';
import { findCustomer } from '../store.mjs';

test('finds an existing customer', () => {
  const rows = findCustomer('alice');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'alice@atlas.example');
});

test('finds a different customer by name', () => {
  assert.equal(findCustomer('carol')[0].email, 'carol@atlas.example');
});

test('returns an empty list for an unknown name', () => {
  assert.deepEqual(findCustomer('nobody'), []);
});

test('returns only the name and email columns', () => {
  assert.deepEqual(Object.keys(findCustomer('bob')[0]), ['name', 'email']);
});

test('security: a SQL injection payload returns no customers', () => {
  assert.deepEqual(findCustomer("' OR 1=1 --"), []);
});
