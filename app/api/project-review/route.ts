import { type NextRequest, NextResponse } from 'next/server';
import { type ProjectReport, type ProjectReviewEvent, type ProjectUpdate, uploadLimit } from '../../../lib/project-review';
import { aiReview } from '../../../lib/server/project-ai';
import { packProject, unpackProject, UploadError } from '../../../lib/server/project-archive';
import { identifyProject, reviewSources } from '../../../lib/server/project-rules';
import { dockerReady, isolatedTests } from '../../../lib/server/project-tests';

export const runtime = 'nodejs';
let reviewing = false;

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

async function runReview(request: NextRequest, emit: (update: ProjectUpdate) => void) {
  emit({ squad: 'neutral', agent: 'Director', text: 'Receiving the project ZIP and checking Docker availability.' });
  const image = await dockerReady();
  if (!image) throw new ReviewUnavailable();
  const { files, excludedFiles } = await unpackProject(await readUpload(request));
  const { framework, path } = identifyProject(files);
  emit({ squad: 'red', agent: 'Scout', text: 'Identified ' + framework + '. Reviewing the uploaded source for security issues.' });
  const local = reviewSources(files);
  if (!local.scannedFiles) throw new UploadError('No supported JavaScript or TypeScript source files were found.');
  const report: ProjectReport = {
    framework, excludedFiles, scannedFiles: local.scannedFiles, findings: local.findings, checks: local.checks, changes: local.changes,
    ai: 'Off. Source stayed in Hex.', tests: { baseline: 'Not run.', patched: 'Not run.' },
  };
  for (const finding of local.findings.slice(0, 12)) {
    emit({ squad: 'red', agent: 'Scout', text: finding.title + ' at ' + finding.file + ':' + finding.line + '.' });
  }
  if (request.nextUrl.searchParams.get('ai') === '1') {
    emit({ squad: 'red', agent: 'Scout', text: 'Requesting OpenAI review of the selected source files.' });
    const result = await aiReview(local.aiSources);
    report.ai = result.status;
    report.findings.push(...result.findings);
    for (const finding of result.findings) {
      emit({ squad: 'red', agent: 'Scout', text: 'AI advisory: ' + finding.title + ' at ' + finding.file + ':' + finding.line + '.' });
    }
  }
  emit({ squad: 'neutral', agent: 'Verifier', text: 'Running baseline checks in Docker on the original project.' });
  report.tests.baseline = await isolatedTests(files, path, image);
  emit({ squad: 'neutral', agent: 'Verifier', text: 'Baseline: ' + report.tests.baseline });
  let output = local.patched;
  if (local.checks.length) {
    emit({ squad: 'blue', agent: 'Patch Engineer', text: 'Prepared ' + local.changes.length + ' targeted edit(s) across ' + local.checks.length + ' file(s). Submitting the candidate for verification.' });
    for (const finding of local.findings.filter(({ status }) => status === 'Patched').slice(0, 12)) {
      emit({ squad: 'blue', agent: 'Patch Engineer', text: finding.detail + ' Candidate file: ' + finding.file + '.' });
    }
    emit({ squad: 'neutral', agent: 'Verifier', text: 'Running Docker checks on the patched copy.' });
    report.tests.patched = await isolatedTests(local.patched, path, image);
    emit({ squad: 'neutral', agent: 'Verifier', text: 'Patched copy: ' + report.tests.patched });
    if (report.tests.patched.startsWith('Failed') || report.tests.patched.includes('failed')) {
      output = files;
      report.changes = [];
      for (const finding of report.findings) {
        if (finding.status !== 'Patched') continue;
        finding.status = 'Review';
        finding.detail = 'Candidate reverted after the patched copy failed Docker verification.';
      }
      report.checks.push('All candidate edits were reverted.');
      emit({ squad: 'blue', agent: 'Patch Engineer', text: 'Reverted the candidate after the Docker checks failed.' });
    } else {
      emit({ squad: 'blue', agent: 'Patch Engineer', text: 'Keeping the candidate edits based on the Docker checks shown above.' });
    }
  } else {
    report.tests.patched = report.tests.baseline + ' No source edits were applied.';
    emit({ squad: 'blue', agent: 'Patch Engineer', text: 'No supported automatic fixes were found. Review findings are in the report.' });
  }
  const zip = await packProject(output, JSON.stringify(report, null, 2) + '\n');
  return { report, archive: zip.toString('base64') };
}

class ReviewUnavailable extends Error {}

function reviewFailure(error: unknown) {
  if (error instanceof ReviewUnavailable) return {
    message: 'Start Docker Desktop and run docker pull node:24-bookworm-slim, then retry.', status: 503,
  };
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
  if (request.headers.get('content-type') !== 'application/zip') {
    return NextResponse.json({ error: 'Upload a ZIP archive.' }, { status: 415 });
  }
  if (reviewing) return NextResponse.json({ error: 'A review is already running. Try again shortly.' }, { status: 429 });
  reviewing = true;
  if (request.nextUrl.searchParams.get('stream') === '1') return streamReview(request);
  try {
    const result = await runReview(request, () => {});
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { message, status } = reviewFailure(error);
    return NextResponse.json({ error: message }, { status });
  } finally {
    reviewing = false;
  }
}

function streamReview(request: NextRequest) {
  const encoder = new TextEncoder();
  let disconnected = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: ProjectReviewEvent) {
        if (!disconnected) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      }
      try {
        const result = await runReview(request, (update) => send({ type: 'update', update }));
        send({ type: 'complete', result });
      } catch (error) {
        send({ type: 'error', message: reviewFailure(error).message });
      } finally {
        reviewing = false;
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