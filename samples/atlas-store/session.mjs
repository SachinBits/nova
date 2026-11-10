// Deliberately vulnerable demo code for Hex. Do not reuse this code.
import fs from 'node:fs';
import path from 'node:path';

export function readInvoice(req) {
  return fs.readFileSync(path.join('invoices', req.params.file));
}

export function issueSession() {
  const sessionToken = Math.random().toString(36).slice(2);
  return sessionToken;
}
