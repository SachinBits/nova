import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { advance, directive, listRuns, receipt, startRun, updateRun } from '../../../lib/server/arena';

export const runtime = 'nodejs';
const cookie = 'hex_arena_owner';

function ownerOf(request: NextRequest) {
  const owner = request.cookies.get(cookie)?.value;
  return owner && /^[0-9a-f-]{36}$/.test(owner) ? owner : undefined;
}

export function GET(request: NextRequest) {
  const owner = ownerOf(request);
  const id = request.nextUrl.searchParams.get('id');
  const run = owner && id ? advance(owner, id) : null;
  if (id && !run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  if (run && request.nextUrl.searchParams.has('receipt')) {
    return NextResponse.json(receipt(run), {
      headers: { 'Content-Disposition': 'attachment; filename="hex-' + run.id + '.json"' },
    });
  }
  return NextResponse.json({ run, runs: owner ? listRuns(owner) : [] });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  // Next can normalize the hostname in nextUrl. The Host header retains the browser's authority.
  const host = request.headers.get('host');
  const expectedOrigin = host ? request.nextUrl.protocol + '//' + host : request.nextUrl.origin;
  // Fetch Metadata is set by the browser and reflects the origin before any server URL rewrites.
  const fetchSite = request.headers.get('sec-fetch-site');
  const forbidden = fetchSite ? fetchSite !== 'same-origin' : origin && origin !== expectedOrigin;
  if (forbidden) {
    return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const { action, id, message } = body ?? {};
  const owner = ownerOf(request) ?? randomUUID();
  if (action === 'start') {
    const run = startRun(owner);
    const response = NextResponse.json({ run, runs: listRuns(owner) }, { status: 201 });
    response.cookies.set(cookie, owner, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 2592000 });
    return response;
  }
  if (typeof id !== 'string' || !['pause', 'resume', 'approve', 'decline', 'directive'].includes(action)) {
    return NextResponse.json({ error: 'Invalid run action.' }, { status: 400 });
  }
  if (action === 'directive' && (typeof message !== 'string' || !message.trim() || message.length > 2000)) {
    return NextResponse.json({ error: 'Enter a directive of 1 to 2000 characters.' }, { status: 400 });
  }
  const current = advance(owner, id);
  if (!current) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  const run = action === 'directive'
    ? await directive(owner, current, message.trim())
    : updateRun(owner, id, action);
  return NextResponse.json({ run, runs: listRuns(owner) });
}
