import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectUpdate, ReviewFinding } from '../project-review';
import type { LivePush, LiveFinding } from '../live-types';
import { aiEnabled, providerName } from './llm';
import { explain } from './intelligence';
import { exclusive, runReview, titleKey } from './review';

// Push-triggered reviews. Pushes arrive from the GitHub webhook or from the poller, are reviewed one at a
// time, compared with the previous review of the same branch, and reported back as a commit status.

type Watch = { owner: string; repo: string; branch?: string };
const state = globalThis as typeof globalThis & {
  hexLive?: { db: DatabaseSync; dir: string; timer?: NodeJS.Timeout; pumping: boolean; polling?: Promise<void>; defaultBranches: Map<string, string>; lastPoll?: number; pollError?: string };
};

const repoPattern = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})(?:@([A-Za-z0-9._\/-]{1,200}))?$/;
const gate = new Set<ReviewFinding['severity']>(['Critical', 'High']);

export function watchList(): Watch[] {
  return (process.env.HEX_WATCH_REPOS ?? '').split(',').map((item) => item.trim()).filter(Boolean).flatMap((item) => {
    const match = item.match(repoPattern);
    return match ? [{ owner: match[1], repo: match[2], branch: match[3] }] : [];
  });
}
// With a token, conditional requests that return 304 do not count against GitHub's rate limit, so a few
// seconds is fine. Unauthenticated callers get 60 requests an hour, so the poller slows right down.
const pollSeconds = () => process.env.GITHUB_TOKEN?.trim()
  ? Math.max(5, Number(process.env.HEX_POLL_SECONDS) || 10)
  : Math.max(60, Number(process.env.HEX_POLL_SECONDS) || 60);
const recheckSeconds = () => Math.max(60, Number(process.env.HEX_RECHECK_SECONDS) || 900);
const publicUrl = () => (process.env.HEX_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

function live() {
  if (!state.hexLive) {
    const dir = join(dirname(resolve(process.env.HEX_DB_PATH || '.data/hex.sqlite')), 'live');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'live.sqlite'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS pushes (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, received INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pushes_branch ON pushes(repo, branch, received DESC);
      DROP INDEX IF EXISTS pushes_commit;
      CREATE INDEX IF NOT EXISTS pushes_commit_history ON pushes(repo, branch, sha, received DESC);
      CREATE TABLE IF NOT EXISTS live_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    state.hexLive = { db, dir, pumping: false, defaultBranches: new Map() };
    // A restart interrupts a running review; put it back in the queue.
    const interrupted = db.prepare("SELECT snapshot FROM pushes WHERE json_extract(snapshot, '$.status') = 'running'").all();
    for (const { snapshot } of interrupted) {
      const push = JSON.parse(String(snapshot)) as LivePush;
      save({ ...push, status: 'queued', updates: [] });
    }
  }
  return state.hexLive;
}

function save(push: LivePush) {
  live().db.prepare(`
    INSERT INTO pushes VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot
  `).run(push.id, push.repo, push.branch, push.sha, push.receivedAt, JSON.stringify(push));
}

function list(limit: number) {
  return state.hexLive!.db.prepare('SELECT snapshot FROM pushes ORDER BY received DESC LIMIT ?').all(limit)
    .map(({ snapshot }) => JSON.parse(String(snapshot)) as LivePush);
}

export function recentPushes(limit = 30) {
  live();
  return list(limit).map(({ report, ...push }) => ({ ...push, updates: push.status === 'running' ? push.updates.slice(-30) : [], hasReport: !!report }));
}

export function getPush(id: string) {
  const row = live().db.prepare('SELECT snapshot FROM pushes WHERE id = ?').get(id);
  return row ? JSON.parse(String(row.snapshot)) as LivePush : undefined;
}

export async function pushArchive(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return readFile(join(live().dir, id + '.zip')).catch(() => undefined);
}

function previousReview(push: LivePush) {
  const rows = live().db.prepare("SELECT snapshot FROM pushes WHERE repo = ? AND branch = ? AND id != ? ORDER BY received DESC LIMIT 20").all(push.repo, push.branch, push.id);
  return rows.map(({ snapshot }) => JSON.parse(String(snapshot)) as LivePush).find((item) => item.status === 'passed' || item.status === 'failed');
}

export type IncomingPush = { repo: string; branch: string; sha: string; message?: string; author?: string; compare?: string; trigger: LivePush['trigger'] };

export function enqueue(incoming: IncomingPush, repeat = false) {
  live();
  const existing = live().db.prepare('SELECT snapshot FROM pushes WHERE repo = ? COLLATE NOCASE AND branch = ? AND sha = ? ORDER BY received DESC LIMIT 1')
    .get(incoming.repo, incoming.branch, incoming.sha);
  if (existing) {
    const push = JSON.parse(String(existing.snapshot)) as LivePush;
    if (!repeat || push.status === 'queued' || push.status === 'running') return { push, duplicate: true };
  }
  const push: LivePush = {
    id: randomUUID(), ...incoming, message: (incoming.message ?? '').slice(0, 300), author: (incoming.author ?? '').slice(0, 80),
    receivedAt: Date.now(), status: 'queued', updates: [],
  };
  save(push);
  void pump();
  return { push, duplicate: false };
}

// Findings are matched by file and vulnerability class, not exact title or line: AI wording varies between
// runs and line numbers shift with every edit. Each earlier finding can match at most one current finding.
const classOf = (title: string) => titleKey(title) ?? title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(in|via|on|at|the|a|an)\b/g, '').replace(/\s+/g, ' ').trim();
const keyOf = (finding: { file: string; title: string }) => finding.file + '|' + classOf(finding.title);
function unmatched(items: ReviewFinding[], against: ReviewFinding[]) {
  const pool = new Map<string, number>();
  for (const item of against) pool.set(keyOf(item), (pool.get(keyOf(item)) ?? 0) + 1);
  return items.filter((item) => {
    const left = pool.get(keyOf(item)) ?? 0;
    if (left > 0) { pool.set(keyOf(item), left - 1); return false; }
    return true;
  });
}
const brief = ({ file, line, title, severity, status }: ReviewFinding): LiveFinding => ({ file, line, title, severity, status });

async function pump() {
  const runtime = live();
  if (runtime.pumping) return;
  runtime.pumping = true;
  try {
    while (true) {
      const row = runtime.db.prepare("SELECT snapshot FROM pushes WHERE json_extract(snapshot, '$.status') = 'queued' ORDER BY received LIMIT 1").get();
      if (!row) break;
      await reviewPush(JSON.parse(String(row.snapshot)) as LivePush);
    }
  } finally {
    runtime.pumping = false;
  }
}

async function reviewPush(push: LivePush) {
  const [owner, repo] = push.repo.split('/');
  let current: LivePush = { ...push, status: 'running', startedAt: Date.now(), updates: [] };
  save(current);
  if (push.trigger !== 'continuous') await postStatus(current, 'pending', 'Hex security review running');
  current = { ...(getPush(push.id) ?? current), updates: [] };
  const emit = (update: ProjectUpdate) => {
    current.updates = [...current.updates, update].slice(-200);
    save(current);
  };
  try {
    const ai = push.trigger !== 'continuous' && aiEnabled() && process.env.HEX_LIVE_AI !== '0';
    const { report, archive } = await exclusive(() => runReview({ kind: 'github', repo: { owner, repo, ref: push.sha } }, ai, emit, false));
    await writeFile(join(live().dir, push.id + '.zip'), Buffer.from(archive, 'base64'));
    const previous = previousReview(current);
    const earlier = previous?.report?.findings ?? [];
    const introduced = previous ? unmatched(report.findings, earlier) : [];
    const fixed = previous ? unmatched(earlier, report.findings) : [];
    const blocking = (previous ? introduced : report.findings.filter((finding) => finding.severity === 'Critical')).filter((finding) => gate.has(finding.severity));
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const finding of report.findings) counts[finding.severity]++;
    current = {
      ...current, report, finishedAt: Date.now(), status: blocking.length ? 'failed' : 'passed',
      summary: {
        total: report.findings.length, counts, baseline: !previous, previousSha: previous?.sha,
        introduced: introduced.map(brief), fixed: fixed.map(brief), blocking: blocking.length, ai: ai ? providerName() : undefined,
      },
    };
    save(current);
    const description = !previous
      ? 'Baseline: ' + report.findings.length + ' finding(s), ' + counts.Critical + ' critical'
      : introduced.length || fixed.length
        ? introduced.length + ' new (' + blocking.length + ' high/critical), ' + fixed.length + ' fixed'
        : 'No new findings (' + report.findings.length + ' known)';
    if (push.trigger !== 'continuous') await postStatus(current, blocking.length ? 'failure' : 'success', description);
    if (push.trigger !== 'continuous' && process.env.HEX_COMMIT_COMMENTS !== '0' && introduced.length) await postComment(current, introduced, fixed);
    await debrief(current.id, previous?.sha, introduced, fixed, blocking.length);
  } catch (error) {
    current = { ...current, status: 'error', finishedAt: Date.now(), error: error instanceof Error ? error.message.slice(0, 300) : 'Review failed' };
    save(current);
    if (push.trigger !== 'continuous') await postStatus(current, 'error', 'Hex could not review this commit');
  }
}

// Adds the agents' summary to the push conversation: what is new, what was fixed, and the verdict.
async function debrief(id: string, previousSha: string | undefined, introduced: ReviewFinding[], fixed: ReviewFinding[], blocking: number) {
  const push = getPush(id);
  if (!push?.report) return;
  const at = (finding: ReviewFinding) => finding.title + ' at ' + finding.file + ':' + finding.line;
  const lines: ProjectUpdate[] = [];
  if (!previousSha) {
    lines.push({ squad: 'red', agent: 'Scout', text: 'First review of ' + push.branch + ': ' + push.report.findings.length + ' finding(s) recorded as the baseline. Later pushes are compared with this commit.' });
  } else if (introduced.length) {
    lines.push({ squad: 'red', agent: 'Scout', text: 'Compared with ' + previousSha.slice(0, 7) + ', this push introduced ' + introduced.length + ' finding(s): ' + introduced.slice(0, 4).map(at).join('; ') + (introduced.length > 4 ? '; and ' + (introduced.length - 4) + ' more.' : '.') });
  } else {
    lines.push({ squad: 'red', agent: 'Scout', text: 'Compared with ' + previousSha.slice(0, 7) + ', nothing new. This push added no findings.' });
  }
  if (fixed.length) lines.push({ squad: 'blue', agent: 'Patch Engineer', text: fixed.length + ' earlier finding(s) no longer appear: ' + fixed.slice(0, 4).map(at).join('; ') + (fixed.length > 4 ? '; and more.' : '.') });
  const verdict = push.status === 'failed'
    ? 'Verdict: failed. ' + blocking + ' high or critical finding(s) ' + (previousSha ? 'arrived with this push.' : 'are present.')
    : 'Verdict: passed. Nothing high or critical ' + (previousSha ? 'arrived with this push.' : 'is present.');
  lines.push({ squad: 'neutral', agent: 'Director', text: verdict + (push.githubStatus ? ' GitHub: ' + push.githubStatus.replace(/^Result /, '') + '.' : '') });
  if (push.trigger !== 'continuous' && aiEnabled() && process.env.HEX_LIVE_AI !== '0') {
    const note = await explain('Triage, the blue team lead reviewing a git push. Tell the developer what matters most in this push and what to fix first', {
      repo: push.repo, commit: push.message, introduced: introduced.slice(0, 8).map(({ title, file, line, severity }) => ({ title, file, line, severity })),
      fixed: fixed.slice(0, 8).map(({ title, file }) => ({ title, file })), baseline: !previousSha, totalFindings: push.report.findings.length,
    }, '');
    if (note.text) lines.push({ squad: 'blue', agent: 'Triage', text: note.text });
  }
  const latest = getPush(id);
  if (latest) save({ ...latest, updates: [...latest.updates, ...lines].slice(-220) });
}

async function github(path: string, body: unknown) {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return 'Not posted: set GITHUB_TOKEN to report results on GitHub.';
  try {
    const response = await fetch('https://api.github.com' + path, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'hex-review', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return 'Posted';
    const failure = await response.json().catch(() => null) as { message?: string } | null;
    return 'Not posted: HTTP ' + response.status + (failure?.message ? ' ' + failure.message.slice(0, 120) : '')
      + (response.status === 403 || response.status === 404 ? ' (the token needs Commit statuses: read and write on this repository)' : '');
  } catch {
    return 'Not posted: GitHub could not be reached.';
  }
}

async function postStatus(push: LivePush, status: 'pending' | 'success' | 'failure' | 'error', description: string) {
  const result = await github('/repos/' + push.repo + '/statuses/' + push.sha, {
    state: status, description: description.slice(0, 140), context: 'hex/security-review', target_url: publicUrl() + '/live?push=' + push.id,
  });
  const latest = getPush(push.id) ?? push;
  save({ ...latest, githubStatus: (status === 'pending' ? 'Pending status ' : 'Result ') + result.charAt(0).toLowerCase() + result.slice(1) });
}

async function postComment(push: LivePush, introduced: ReviewFinding[], fixed: ReviewFinding[]) {
  const rows = introduced.slice(0, 15).map((finding) => '| ' + finding.severity + ' | ' + finding.title.replace(/\|/g, '/') + ' | `' + finding.file + ':' + finding.line + '` |');
  const body = '### Hex security review\n\nThis push introduced **' + introduced.length + '** new finding(s)' + (fixed.length ? ' and fixed **' + fixed.length + '**' : '') + '.\n\n'
    + '| Severity | Finding | Location |\n|---|---|---|\n' + rows.join('\n') + (introduced.length > 15 ? '\n\n…and ' + (introduced.length - 15) + ' more.' : '')
    + '\n\n[Full report](' + publicUrl() + '/live?push=' + push.id + ')';
  const result = await github('/repos/' + push.repo + '/commits/' + push.sha + '/comments', { body });
  const latest = getPush(push.id) ?? push;
  save({ ...latest, githubComment: result.startsWith('Posted') ? 'Posted' : result.replace('Commit statuses', 'Contents') });
}

// Poller: asks GitHub for the head commit of each watched branch. Conditional requests keep it cheap.
export async function pollOnce(manual = false) {
  const runtime = live();
  // A slow GitHub response must not stack polls on top of each other.
  if (runtime.polling && !manual) return;
  while (runtime.polling) await runtime.polling;
  const pending = pollRepos(runtime, manual);
  runtime.polling = pending;
  try { await pending; } finally { runtime.polling = undefined; }
}

async function pollRepos(runtime: NonNullable<typeof state.hexLive>, manual: boolean) {
  runtime.lastPoll = Date.now();
  runtime.pollError = undefined;
  const token = process.env.GITHUB_TOKEN?.trim();
  for (const watch of watchList()) {
    const name = watch.owner + '/' + watch.repo;
    if (!manual && !continuousEnabled()) break;
    try {
      const response = await fetch('https://api.github.com/repos/' + name + '/commits?per_page=1' + (watch.branch ? '&sha=' + encodeURIComponent(watch.branch) : ''), {
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/vnd.github+json', 'User-Agent': 'hex-review', 'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      });
      if (!response.ok) { runtime.pollError = name + ': HTTP ' + response.status + (response.status === 403 ? ' (rate limited; add GITHUB_TOKEN)' : ''); continue; }
      const [head] = await response.json() as { sha: string; html_url: string; commit: { message: string; author?: { name?: string } } }[];
      if (!head) continue;
      let branch = watch.branch ?? runtime.defaultBranches.get(name);
      if (!branch) {
        const info = await fetch('https://api.github.com/repos/' + name, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hex-review', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
        branch = info.ok ? ((await info.json()) as { default_branch?: string }).default_branch : undefined;
        if (!branch) continue;
        runtime.defaultBranches.set(name, branch);
      }
      if (!manual && !continuousEnabled()) break;
      const row = runtime.db.prepare('SELECT snapshot FROM pushes WHERE repo = ? COLLATE NOCASE AND branch = ? AND sha = ? ORDER BY received DESC LIMIT 1')
        .get(name, branch, head.sha);
      const previous = row ? JSON.parse(String(row.snapshot)) as LivePush : undefined;
      const due = !!previous && Date.now() - (previous.finishedAt ?? previous.receivedAt) >= recheckSeconds() * 1000;
      if (!manual && previous && !due) continue;
      enqueue({
        repo: name, branch, sha: head.sha, message: head.commit.message.split('\n')[0],
        author: head.commit.author?.name, compare: head.html_url, trigger: manual ? 'manual' : previous ? 'continuous' : 'poll',
      }, manual || due);
    } catch {
      runtime.pollError = name + ': GitHub could not be reached';
    }
  }
}

function continuousEnabled() {
  const row = live().db.prepare("SELECT value FROM live_settings WHERE key = 'continuous'").get();
  return row ? row.value === 1 : process.env.HEX_CONTINUOUS === '1';
}

export function setContinuous(enabled: boolean) {
  const runtime = live();
  runtime.db.prepare("INSERT INTO live_settings VALUES ('continuous', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(enabled ? 1 : 0);
  if (!enabled) {
    clearInterval(runtime.timer);
    runtime.timer = undefined;
    runtime.db.prepare("DELETE FROM pushes WHERE json_extract(snapshot, '$.status') = 'queued' AND json_extract(snapshot, '$.trigger') IN ('continuous', 'poll')").run();
  }
  if (enabled) startLive();
}

export function startLive() {
  const runtime = live();
  void pump();
  if (runtime.timer || !continuousEnabled() || !watchList().length) return;
  void pollOnce();
  runtime.timer = setInterval(() => void pollOnce(), pollSeconds() * 1000);
  runtime.timer.unref();
}

export function liveConfig() {
  const runtime = live();
  return {
    watching: watchList().map(({ owner, repo, branch }) => owner + '/' + repo + (branch ? '@' + branch : '')),
    pollSeconds: pollSeconds(),
    continuous: continuousEnabled(),
    recheckSeconds: recheckSeconds(),
    lastPoll: runtime.lastPoll,
    pollError: runtime.pollError,
    webhook: !!process.env.GITHUB_WEBHOOK_SECRET?.trim(),
    token: !!process.env.GITHUB_TOKEN?.trim(),
    ai: aiEnabled() && process.env.HEX_LIVE_AI !== '0' ? providerName() : undefined,
    publicUrl: publicUrl(),
  };
}

