import { type NextRequest, NextResponse } from 'next/server';
import { type ProjectReport, type ProjectReviewEvent, type ProjectUpdate, testCounts, type TestResult, uploadLimit } from '../../../lib/project-review';
import { type AiPatch, aiReview, applyAiPatches } from '../../../lib/server/project-ai';
import { packProject, unpackProject, UploadError } from '../../../lib/server/project-archive';
import { identifyProject, reviewSources } from '../../../lib/server/project-rules';
import { dockerReady, isolatedTests } from '../../../lib/server/project-tests';

export const runtime = 'nodejs';
let reviewing = false;
const notRun: TestResult = { syntaxOk: false, jsChecked: 0, pass: 0, fail: 0, summary: 'Not run.' };

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
    ai: 'Off. Source stayed in Hex.', tests: { baseline: notRun, patched: notRun }, kept: 'None', tsChecked: 0,
  };
  let aiPatches: AiPatch[] = [];
  for (const finding of local.findings.slice(0, 12)) {
    emit({ squad: 'red', agent: 'Scout', text: finding.title + ' at ' + finding.file + ':' + finding.line + '.' });
  }
  if (request.nextUrl.searchParams.get('ai') === '1') {
    emit({ squad: 'red', agent: 'Scout', text: 'Requesting OpenAI review of the selected source files.' });
    const result = await aiReview(local.aiSources);
    report.ai = result.status;
    report.findings.push(...result.findings);
    aiPatches = result.patches;
    emit({ squad: 'red', agent: 'Scout', text: 'AI review: ' + result.status });
    for (const finding of result.findings) {
      emit({ squad: 'red', agent: 'Scout', text: 'AI advisory: ' + finding.title + ' at ' + finding.file + ':' + finding.line + '.' });
    }
  }
  emit({ squad: 'neutral', agent: 'Verifier', text: 'Running baseline checks in Docker on the original project.' });
  const baseline = report.tests.baseline = await isolatedTests(files, path, image);
  emit({ squad: 'neutral', agent: 'Verifier', text: 'Baseline: ' + baseline.summary + ' ' + testCounts(baseline) + '.' });
  let output = files;
  const proposed = applyAiPatches(files, local.patched, aiPatches);
  const candidates: { label: ProjectReport['kept']; files: Map<string, Buffer> }[] = [];
  if (proposed.applied.length) candidates.push({ label: local.checks.length ? 'Deterministic + AI' : 'AI only', files: proposed.files });
  if (local.checks.length) candidates.push({ label: 'Deterministic only', files: local.patched });
  if (candidates.length) {
    const edits = [...local.changes, ...proposed.changes];
    emit({ squad: 'blue', agent: 'Patch Engineer', text: 'Prepared ' + edits.length + ' targeted edit(s) across ' + new Set(edits.map(({ file }) => file)).size + ' file(s). Submitting the candidate for verification.' });
    for (const finding of local.findings.filter(({ status }) => status === 'Patched').slice(0, 12)) {
      emit({ squad: 'blue', agent: 'Patch Engineer', text: finding.detail + ' Candidate file: ' + finding.file + '.' });
    }
    for (const { finding } of proposed.applied) {
      emit({ squad: 'blue', agent: 'Patch Engineer', text: 'AI-proposed patch for ' + finding.title + '. Candidate file: ' + finding.file + '.' });
    }
    for (const candidate of candidates) {
      emit({ squad: 'neutral', agent: 'Verifier', text: 'Running Docker checks on the patched copy (' + candidate.label + ').' });
      // Every edited file already passed transpileModule before it could join a candidate.
      report.tsChecked = [...candidate.files].filter(([file, bytes]) => /\.[cm]?tsx?$/i.test(file) && bytes !== files.get(file)).length;
      const patched = report.tests.patched = await isolatedTests(candidate.files, path, image);
      emit({ squad: 'neutral', agent: 'Verifier', text: 'Patched copy: ' + patched.summary + ' ' + testCounts(patched) + '.' });
      if (patched.syntaxOk && patched.fail <= baseline.fail && patched.pass >= baseline.pass) {
        output = candidate.files;
        report.kept = candidate.label;
        break;
      }
    }
    if (report.kept.includes('AI')) {
      report.changes.push(...proposed.changes);
      for (const { finding } of proposed.applied) {
        finding.status = 'Patched';
        finding.detail = 'AI-proposed. ' + finding.detail;
      }
    } else if (proposed.applied.length) {
      report.checks.push('AI-proposed patches were rejected by Docker verification.');
    }
    const verification = report.tests.patched.pass > 0 ? 'test-verified' as const
      : report.tests.patched.fail > 0 ? 'syntax-checked in Docker (no passing tests)' as const : 'syntax-checked in Docker (no tests)' as const;
    if (report.kept !== 'None') {
      for (const finding of report.findings) if (finding.status === 'Patched') finding.verification = verification;
    }
    if (report.kept === 'None') {
      report.changes = [];
      for (const finding of report.findings) {
        if (finding.status !== 'Patched') continue;
        finding.status = 'Review';
        finding.detail = 'Candidate reverted after the patched copy failed Docker verification.';
      }
      report.checks.push('All candidate edits were reverted.');
      emit({ squad: 'blue', agent: 'Patch Engineer', text: 'Reverted the candidate after the Docker checks failed.' });
    } else {
      emit({ squad: 'blue', agent: 'Patch Engineer', text: 'Keeping the candidate edits based on the Docker checks shown above (' + report.kept + ', ' + verification + ').' });
    }
  } else {
    report.tests.patched = { ...baseline, summary: baseline.summary + ' No source edits were applied.' };
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