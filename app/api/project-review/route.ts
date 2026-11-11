import { type NextRequest, NextResponse } from 'next/server';
import { type ProjectReviewEvent, uploadLimit } from '../../../lib/project-review';
import { UploadError } from '../../../lib/server/project-archive';
import { parseRepoUrl } from '../../../lib/server/github';
import { exclusive, reviewBusy, runReview, type ReviewSource } from '../../../lib/server/review';

export const runtime = 'nodejs';

async function readUpload(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new UploadError('Select a ZIP project.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > uploadLimit) {
        await reader.cancel();
        throw new UploadError('The ZIP exceeds the 12 MB upload limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
function reviewFailure(error: unknown) {
  if (error instanceof UploadError) return { message: error.message, status: 400 };
  console.error('Project review failed', error instanceof Error ? error.name : 'Unknown error');
  return { message: 'Project review could not finish.', status: 500 };
}

export async function POST(request: NextRequest) {
  const fetchSite = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const expectedOrigin = host ? request.nextUrl.protocol + '//' + host : request.nextUrl.origin;
  if (fetchSite ? fetchSite !== 'same-origin' : origin && origin !== expectedOrigin) {
    return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 });
  }
  const type = request.headers.get('content-type') ?? '';
  let source: ReviewSource;
  if (type === 'application/zip') {
    source = { kind: 'zip', read: () => readUpload(request) };
  } else if (/^application\/json\b/.test(type)) {
    try {
      const body = await request.text();
      if (body.length > 2048) throw new UploadError('The request is too large.');
      const { repo } = JSON.parse(body) as { repo?: unknown };
      if (typeof repo !== 'string') throw new UploadError('Enter a GitHub repository link.');
      source = { kind: 'github', repo: parseRepoUrl(repo) };
    } catch (error) {
      return NextResponse.json({ error: error instanceof UploadError ? error.message : 'Send {"repo": "<GitHub link>"}.' }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'Upload a ZIP archive or send a GitHub repository link.' }, { status: 415 });
  }
  const ai = request.nextUrl.searchParams.get('ai') === '1';
  if (request.nextUrl.searchParams.get('stream') === '1') return streamReview(source, ai);
  // Without a live stream the caller cannot see a queue position, so a busy reviewer answers 429.
  if (reviewBusy()) return NextResponse.json({ error: 'A review is already running. Try again shortly.' }, { status: 429 });
  try {
    const result = await exclusive(() => runReview(source, ai, () => {}));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { message, status } = reviewFailure(error);
    return NextResponse.json({ error: message }, { status });
  }
}

function streamReview(source: ReviewSource, ai: boolean) {
  const encoder = new TextEncoder();
  let disconnected = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: ProjectReviewEvent) {
        if (!disconnected) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      }
      try {
        if (reviewBusy()) send({ type: 'update', update: { squad: 'neutral', agent: 'Director', text: 'Another review is running (possibly a GitHub push). This one is queued and starts next.' } });
        const result = await exclusive(() => runReview(source, ai, (update) => send({ type: 'update', update })));
        send({ type: 'complete', result });
      } catch (error) {
        send({ type: 'error', message: reviewFailure(error).message });
      } finally {
        if (!disconnected) controller.close();
      }
    },
    cancel() {
      disconnected = true;
    },
  });
  return new Response(stream, { headers: {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  } });
}