import { type NextRequest, NextResponse } from 'next/server';
import { type ProjectReport, type ProjectReviewEvent, type ProjectUpdate, type ReviewFinding, testCounts, type TestResult, uploadLimit } from '../../../lib/project-review';
import { posix } from 'node:path';
import { type AiPatch, type Budget, type PovInput, aiReview, applyAiPatches, generatePovTests, retryPatch } from '../../../lib/server/project-ai';
import { packProject, unpackProject, UploadError } from '../../../lib/server/project-archive';
import { identifyProject, parses, reviewSources, sourceName } from '../../../lib/server/project-rules';
import { dockerReady, isolatedTests, pyCompile, pythonReady, type Runtime } from '../../../lib/server/project-tests';

const severityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;
const isTestFile = /(^|\/)(?:tests?|__tests__)\/|[.-](?:test|spec)\.[^/]+$/i;
const isPyTestFile = /(^|\/)(?:tests?\/.+|test_[^/]+|[^/]+_test)\.py$/;
// A curated subset of the Python standard library; anything else is treated as a third-party import.
const PYTHON_STDLIB = new Set(['__future__', 'abc', 'argparse', 'ast', 'asyncio', 'base64', 'binascii', 'bisect', 'calendar', 'cgi', 'cmath', 'collections', 'configparser', 'contextlib', 'copy', 'csv', 'ctypes', 'datetime', 'decimal', 'difflib', 'dis', 'email', 'enum', 'errno', 'functools', 'gc', 'getpass', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'logging', 'math', 'mimetypes', 'multiprocessing', 'operator', 'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'select', 'shlex', 'shutil', 'signal', 'smtplib', 'socket', 'sqlite3', 'ssl', 'stat', 'string', 'struct', 'subprocess', 'sys', 'tarfile', 'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'weakref', 'xml', 'zipfile', 'zlib']);

function regionOf(content: string, line: number) {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 3)).map((text, i) => (Math.max(0, line - 4) + i + 1) + ': ' + text).join('\n').slice(0, 1500);
}

// Self-contained = imports resolve only to language builtins/stdlib or to files present in the ZIP.
function selfContained(file: string, content: string, files: Map<string, Buffer>) {
  if (/\.py$/i.test(file)) {
    for (const match of content.matchAll(/^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/gm)) {
      const mod = (match[1] || match[2] || '').split('.')[0];
      if (!mod || PYTHON_STDLIB.has(mod)) continue;
      if (files.has(posix.join(posix.dirname(file), mod + '.py')) || files.has(mod + '.py')) continue;
      return false;
    }
    return true;
  }
  for (const [, spec] of content.matchAll(/(?:from|require\(|import)\s*['"]([^'"]+)['"]/g)) {
    if (spec.startsWith('node:')) continue;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const base = posix.normalize(posix.join(posix.dirname(file), spec));
      if (![base, base + '.mjs', base + '.js', base + '.cjs', base + '.ts', base + '.tsx'].some((candidate) => files.has(candidate))) return false;
      continue;
    }
    return false;
  }
  return true;
}

export const runtime = 'nodejs';
let reviewing = false;

// Collapses a finding title to a vulnerability class so AI restatements can be matched to deterministic ones.
function titleKey(title: string) {
  const t = title.toLowerCase();
  // Command is checked before SQL so "command injection" does not fall into the "injection" -> sql rule.
  if (/command inj|os command|shell|\bexec\b/.test(t)) return 'command';
  if (/sql|sqli|injection/.test(t)) return 'sql';
  if (/path travers|traversal|directory/.test(t)) return 'path';
  // Random is checked before secret so "weak random session token" is not classed as a secret.
  if (/random|prng|predictable/.test(t)) return 'random';
  if (/secret|api[ _-]?key|password|credential|hard-?coded|token/.test(t)) return 'secret';
  if (t.includes('cors')) return 'cors';
  if (/\bfunction\b|eval|dynamic code|deseriali/.test(t)) return 'code';
  return null;
}
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
  const nodeId = await dockerReady();
  const { files, excludedFiles } = await unpackProject(await readUpload(request));
  const { framework, path } = identifyProject(files);
  const isPython = framework === 'Python';
  const pythonId = isPython ? await pythonReady() : undefined;
  // Non-Python projects need the Node image; a Python project degrades to flag-only when its image is missing.
  if (!isPython && !nodeId) throw new ReviewUnavailable();
  const runtime: Runtime | undefined = isPython ? (pythonId ? { image: pythonId, kind: 'python' } : undefined) : { image: nodeId!, kind: 'node' };
  const rootDir = path ? posix.dirname(path) : '';
  emit({ squad: 'red', agent: 'Scout', text: 'Identified ' + framework + '. Reviewing the uploaded source for security issues.' });
  const local = reviewSources(files);
  if (!local.scannedFiles) throw new UploadError('No supported JavaScript, TypeScript, Python or other supported source files were found.');
  const report: ProjectReport = {
    framework, excludedFiles, scannedFiles: local.scannedFiles, findings: local.findings, checks: local.checks, changes: local.changes,
    ai: 'Off. Source stayed in Hex.', tests: { baseline: notRun, patched: notRun }, kept: 'None', tsChecked: 0,
  };
  let aiPatches: AiPatch[] = [];
  const ai = request.nextUrl.searchParams.get('ai') === '1';
  // Beyond the findings call, at most one retry and one exploit-test call per review: a hard cap of 3.
  const budget: Budget = { calls: 0, max: 3 };
  for (const finding of local.findings.slice(0, 12)) {
    emit({ squad: 'red', agent: 'Scout', text: finding.title + ' at ' + finding.file + ':' + finding.line + '.' });
  }
  if (ai) {
    emit({ squad: 'red', agent: 'Scout', text: 'Requesting OpenAI review of the selected source files.' });
    const result = await aiReview(local.aiSources, budget);
    report.ai = result.status;
    // When an AI finding restates a deterministic one, keep whichever is (or will be) Patched so the
    // same vulnerability never shows twice. The deterministic scanner only flags path traversal and weak
    // randomness, so an AI fix for those wins over the deterministic Review and keeps its CWE/severity.
    const deterministic = report.findings.slice();
    const overlaps = (d: ReviewFinding, candidate: ReviewFinding) => d.file === candidate.file
      && (Math.abs(d.line - candidate.line) <= 4 || (titleKey(d.title) !== null && titleKey(d.title) === titleKey(candidate.title)));
    const dropDeterministic = new Set<ReviewFinding>();
    const fresh: ReviewFinding[] = [];
    for (const candidate of result.findings) {
      const hasPatch = result.patches.some((patch) => patch.finding === candidate);
      // Prefer a same-class match so nearby findings of different classes are not confused by line proximity.
      const sameClass = titleKey(candidate.title) !== null
        && deterministic.find((d) => d.file === candidate.file && titleKey(d.title) === titleKey(candidate.title) && !dropDeterministic.has(d));
      const duplicate = sameClass || deterministic.find((d) => overlaps(d, candidate) && !dropDeterministic.has(d));
      if (!duplicate) { fresh.push(candidate); continue; }
      // Keep the AI finding only when it fixes what the deterministic one merely flagged.
      if (duplicate.status !== 'Patched' && hasPatch) {
        candidate.cwe = duplicate.cwe;
        candidate.severity = duplicate.severity;
        dropDeterministic.add(duplicate);
        fresh.push(candidate);
      }
    }
    if (dropDeterministic.size) report.findings = report.findings.filter((finding) => !dropDeterministic.has(finding));
    report.findings.push(...fresh);
    aiPatches = result.patches.filter((patch) => fresh.includes(patch.finding));
    emit({ squad: 'red', agent: 'Scout', text: 'AI review: ' + result.status });
    for (const finding of fresh) {
      emit({ squad: 'red', agent: 'Scout', text: 'AI advisory: ' + finding.title + ' at ' + finding.file + ':' + finding.line + '.' });
    }
  }
  const validate = (file: string, text: string) => sourceName.test(file) ? parses(file, text)
    : runtime && runtime.kind === 'python' ? pyCompile(file, text, runtime) : false;
  if (!runtime) {
    // Python project without the python:3.12-slim image: scan and flag only, never fail the review.
    const skipped: TestResult = { syntaxOk: false, jsChecked: 0, pass: 0, fail: 0, summary: 'Python verification unavailable — pull python:3.12-slim to enable fixes.' };
    report.tests.baseline = report.tests.patched = skipped;
    for (const finding of report.findings) if (/\.py$/i.test(finding.file)) finding.detail += ' Python verification is unavailable in this sandbox; pull python:3.12-slim to enable fixes.';
    emit({ squad: 'neutral', agent: 'Verifier', text: skipped.summary });
    report.aiCalls = budget.calls;
    const zip = await packProject(files, JSON.stringify(report, null, 2) + '\n');
    return { report, archive: zip.toString('base64') };
  }
  emit({ squad: 'neutral', agent: 'Verifier', text: 'Running baseline checks in Docker on the original project.' });
  const baseline = report.tests.baseline = await isolatedTests(files, rootDir, runtime);
  emit({ squad: 'neutral', agent: 'Verifier', text: 'Baseline: ' + baseline.summary + ' ' + testCounts(baseline) + '.' });
  let output = files;
  const proposed = await applyAiPatches(files, local.patched, aiPatches, validate);
  // SWE-agent retry: one feedback attempt on the highest-severity AI patch that failed to apply.
  if (proposed.failed.length) {
    const worst = proposed.failed.sort((a, b) => severityOrder[a.patch.finding.severity] - severityOrder[b.patch.finding.severity])[0];
    emit({ squad: 'blue', agent: 'Patch Engineer', text: 'An AI patch for ' + worst.patch.finding.title + ' did not apply (' + worst.reason + '). Asking the model to correct it once.' });
    const retry = await retryPatch(worst, budget);
    const file = worst.patch.finding.file;
    const content = proposed.files.get(file)?.toString('utf8') ?? '';
    if (retry && content.split(retry.find).length - 1 === 1) {
      const text = content.split(retry.find).join(retry.replace);
      if (await validate(file, text)) {
        proposed.files.set(file, Buffer.from(text));
        proposed.changes.push({ file, line: worst.patch.finding.line, before: retry.find, after: retry.replace });
        proposed.applied.push(worst.patch);
        emit({ squad: 'blue', agent: 'Patch Engineer', text: 'The corrected AI patch for ' + worst.patch.finding.title + ' applied cleanly.' });
      }
    }
  }
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
      const patched = report.tests.patched = await isolatedTests(candidate.files, rootDir, runtime);
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
  if (ai && process.env.OPENAI_API_KEY && report.kept !== 'None') {
    await povPass(report, files, output, runtime, budget, emit);
  }
  report.aiCalls = budget.calls;
  emit({ squad: 'neutral', agent: 'Director', text: 'OpenAI calls this review: ' + budget.calls + '.' });
  const zip = await packProject(output, JSON.stringify(report, null, 2) + '\n');
  return { report, archive: zip.toString('base64') };
}

// Buttercup proof-of-vulnerability pass: prove kept fixes with generated exploit tests, isolated from keep/revert.
async function povPass(report: ProjectReport, original: Map<string, Buffer>, final: Map<string, Buffer>, runtime: Runtime, budget: Budget, emit: (update: ProjectUpdate) => void) {
  const key = (finding: { file: string; line: number }) => finding.file + ':' + finding.line;
  const selected = report.findings.filter((finding) => finding.status === 'Patched' && (sourceName.test(finding.file) || /\.py$/i.test(finding.file))
    && selfContained(finding.file, (final.get(finding.file) ?? original.get(finding.file))!.toString('utf8'), final))
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]).slice(0, 3);
  if (!selected.length) return;
  const inputs: PovInput[] = selected.map((finding) => {
    const py = /\.py$/i.test(finding.file);
    const change = report.changes.find((c) => c.file === finding.file && Math.abs(c.line - finding.line) <= 4) ?? report.changes.find((c) => c.file === finding.file);
    return {
      findingKey: key(finding),
      language: py ? 'py' : 'js',
      // Python tests sit beside the module and import it by name; JS tests live under hex-pov/.
      importPath: py ? posix.basename(finding.file).replace(/\.py$/i, '') : posix.relative('hex-pov', finding.file),
      title: finding.title,
      region: regionOf(original.get(finding.file)!.toString('utf8'), finding.line),
      fix: change ? change.before + ' => ' + change.after.trim() : '',
    };
  });
  emit({ squad: 'red', agent: 'Scout', text: 'Generating exploit tests for ' + selected.length + ' fixed finding(s).' });
  const tests = await generatePovTests(inputs, budget);
  // The project's own tests are dropped so the only test run is the generated exploit for this finding.
  const strip = (map: Map<string, Buffer>) => new Map([...map].filter(([p]) => !isTestFile.test(p) && !isPyTestFile.test(p)));
  const base = strip(original);
  const patchedBase = strip(final);
  for (const test of tests) {
    const target = selected.find((finding) => key(finding) === test.findingKey);
    if (!target) continue;
    const py = /\.py$/i.test(target.file);
    // Alphanumeric only: a dot in the name would make Python treat it as a dotted module path.
    const safe = test.findingKey.replace(/[^a-z0-9]+/gi, '_');
    const moduleDir = posix.dirname(target.file).replace(/^\.$/, '');
    const povPath = py ? posix.join(moduleDir || '.', 'test_hexpov_' + safe + '.py').replace(/^\.\//, '') : 'hex-pov/' + safe + '.test.mjs';
    const povRoot = py ? moduleDir : '';
    const buffer = Buffer.from(test.testSource);
    let before, after;
    try {
      before = await isolatedTests(new Map(base).set(povPath, buffer), povRoot, runtime);
      after = await isolatedTests(new Map(patchedBase).set(povPath, buffer), povRoot, runtime);
    } catch {
      continue; // A Docker error never downgrades a finding; the fix keeps its current label.
    }
    const proven = before.syntaxOk && after.syntaxOk && before.pass === 0 && before.fail >= 1 && after.pass >= 1 && after.fail === 0;
    emit({ squad: 'neutral', agent: 'Verifier', text: 'Exploit test for ' + target.title + ': baseline ' + testCounts(before) + ', patched ' + testCounts(after) + (proven ? ' — proven.' : ' — not proven.') });
    if (proven) target.verification = 'proven by generated exploit test';
  }
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