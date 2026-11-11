import { type NextRequest, NextResponse } from 'next/server';
import { getPush, liveConfig, pollOnce, pushArchive, recentPushes, setContinuous, startLive } from '../../../lib/server/live';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  startLive();
  const id = request.nextUrl.searchParams.get('id');
  if (id) {
    const push = getPush(id);
    if (!push) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    const archive = request.nextUrl.searchParams.get('archive') === '1' ? (await pushArchive(id))?.toString('base64') : undefined;
    return NextResponse.json({ push, archive }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json({ config: liveConfig(), pushes: recentPushes() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  const fetchSite = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const expectedOrigin = host ? request.nextUrl.protocol + '//' + host : request.nextUrl.origin;
  if (fetchSite ? fetchSite !== 'same-origin' : origin !== expectedOrigin) {
    return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 });
  }
  const input = await request.json().catch(() => null);
  if (typeof input?.continuous === 'boolean') setContinuous(input.continuous);
  else { startLive(); await pollOnce(true); }
  return NextResponse.json({ config: liveConfig(), pushes: recentPushes() });
}
