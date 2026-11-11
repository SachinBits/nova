import { type NextRequest, NextResponse } from 'next/server';
import { requirements, type Requirement } from '../../../../lib/tournament';
import { exportCandidate } from '../../../../lib/server/tournament';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const site = request.headers.get('sec-fetch-site');
  if (site ? site !== 'same-origin' : origin !== (host ? request.nextUrl.protocol + '//' + host : request.nextUrl.origin)) {
    return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== 'string' || typeof body?.candidate !== 'string' || !Array.isArray(body?.requirements)
      || body.requirements.length > 2 || !body.requirements.every((key: unknown) => typeof key === 'string' && Object.hasOwn(requirements, key))) {
    return NextResponse.json({ error: 'Invalid tournament request.' }, { status: 400 });
  }
  const bytes = await exportCandidate(body.id, body.candidate, body.requirements as Requirement[]);
  if (!bytes) return NextResponse.json({ error: 'This candidate is ineligible or the session expired. Run the review again.' }, { status: 409 });
  return NextResponse.json({ archive: bytes.toString('base64') }, { headers: { 'Cache-Control': 'no-store' } });
}
