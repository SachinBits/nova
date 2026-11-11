import { createHmac, timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { enqueue, startLive, watchList } from '../../../../lib/server/live';

export const runtime = 'nodejs';

// GitHub push webhook. Every delivery must carry a valid X-Hub-Signature-256 for GITHUB_WEBHOOK_SECRET.
export async function POST(request: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: 'Set GITHUB_WEBHOOK_SECRET to accept webhooks.' }, { status: 503 });
  const body = await request.text();
  if (body.length > 5 * 1024 * 1024) return NextResponse.json({ error: 'Payload too large.' }, { status: 413 });
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }
  startLive();
  const event = request.headers.get('x-github-event');
  if (event === 'ping') return NextResponse.json({ ok: true });
  if (event !== 'push') return NextResponse.json({ ignored: event }, { status: 202 });
  let payload: {
    ref?: string; after?: string; deleted?: boolean; compare?: string;
    repository?: { full_name?: string };
    head_commit?: { message?: string; author?: { name?: string } } | null;
  };
  try { payload = JSON.parse(body); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  const repo = payload.repository?.full_name ?? '';
  const branch = payload.ref?.startsWith('refs/heads/') ? payload.ref.slice('refs/heads/'.length) : '';
  const sha = payload.after ?? '';
  if (payload.deleted || !branch || !/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return NextResponse.json({ ignored: 'not a branch push' }, { status: 202 });
  }
  // With a watch list, only those repositories (and branches, when given) are reviewed.
  const watches = watchList();
  if (watches.length && !watches.some((w) => (w.owner + '/' + w.repo).toLowerCase() === repo.toLowerCase() && (!w.branch || w.branch === branch))) {
    return NextResponse.json({ ignored: 'repository is not in HEX_WATCH_REPOS' }, { status: 202 });
  }
  const { push, duplicate } = enqueue({
    repo, branch, sha, trigger: 'webhook', compare: payload.compare,
    message: payload.head_commit?.message?.split('\n')[0], author: payload.head_commit?.author?.name,
  });
  return NextResponse.json({ queued: push.id, duplicate }, { status: 202 });
}
