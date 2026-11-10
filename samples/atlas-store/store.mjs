// Deliberately vulnerable demo app for Hex. Do not reuse this code.
import { exec } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE customers (name TEXT, email TEXT);
  INSERT INTO customers VALUES
    ('alice', 'alice@atlas.example'),
    ('bob', 'bob@atlas.example'),
    ('carol', 'carol@atlas.example');
`);

const apiKey = 'atlas-demo-key-not-real';

function cors(options = {}) {
  return (request, response, next) => next(options);
}

export const middleware = [cors()];

export function findCustomer(name) {
  return db.prepare(`SELECT name, email FROM customers WHERE name = '${name}'`).all();
}

export function authHeader() {
  return 'Bearer ' + apiKey;
}

export function archiveCustomer(name) {
  exec('tar -czf backup.tgz ' + name);
}

export function applyDiscount(formula) {
  return new Function('return ' + formula)();
}
