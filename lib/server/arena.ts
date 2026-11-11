import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Msg } from '../agents';
import type { Attack, Finding, LabRun, ProbeId, RunSummary } from '../lab-types';
import { escalationSignal, explain } from './intelligence';
import { chooseAction, craftPayload } from './agent-tools';
import { providerName } from './llm';
import { exposed, leakedOrder, probe, verified } from './target';

const checks = [
  { id: 'sql', agent: 'Injector', title: 'Unbounded customer lookup', severity: 'Critical', note: '', fix: 'bind query parameters' },
  { id: 'ownership', agent: 'IDOR Runner', title: 'Cross-account order access', severity: 'High', note: '', fix: 'enforce per-account order ownership' },
  { id: 'prompt', agent: 'Prompt Smuggler', title: 'Private refund code exposure', severity: 'High', note: '', fix: 'keep private codes out of the assistant context' },
  { id: 'ssrf', agent: 'SSRF Hunter', title: 'Link preview reaches cloud metadata', severity: 'Critical',
    note: ' The link-preview endpoint fetched the cloud metadata address and returned a synthetic access key.', fix: 'allow only public https destinations' },
  { id: 'pollution', agent: 'Proto Polluter', title: 'Settings merge pollutes every object', severity: 'High',
    note: ' A settings update with a __proto__ key made a different user\'s fresh session report isAdmin: true.', fix: 'skip __proto__, constructor and prototype keys when merging' },
  { id: 'supply', agent: 'Supply Saboteur', title: 'Hijacked dependency release runs on install', severity: 'Critical',
    note: ' Updating atlas-ui-kit to the hijacked 2.4.1 release ran its postinstall script, which read the synthetic npm publish token.', fix: 'install with --ignore-scripts and require the reviewed lockfile integrity' },
] as const;
// Probes that need nothing from earlier findings run in this order after the SQL attempts.
const modernChecks = checks.slice(3);

// Hard ceiling on AI provider calls per lab run. Beyond it, crafting and policy fall back to deterministic logic.
const AI_BUDGET = 12;
const GOAL_ATTEMPT = 'Goal: find one lookup value that makes the endpoint return a row belonging to the other tenant (bob), revealing a string-concatenation flaw in this synthetic fixture.';
const GOAL_REATTACK = 'The endpoint now binds parameters. Goal: check whether any crafted value can still return the other tenant (bob). It should not.';
// Textbook inputs against the two-row synthetic fixture; used offline and when the AI budget is spent.
const localSqlPayloads = [
  { payload: "' OR 1=1 --", why: 'Boolean tautology returns every row.' },
  { payload: "' UNION SELECT name, order_id FROM customers WHERE name = 'bob' --", why: 'UNION reads the other tenant directly.' },
  { payload: "bob' --", why: 'Comments out the trailing quote to match bob.' },
  { payload: "' OR order_id = 'B-200' --", why: 'Selects by the other account order id.' },
  { payload: "' OR name > 'a' --", why: 'Range predicate matches every customer.' },
];
const localReattackPayloads = [localSqlPayloads[1], localSqlPayloads[3]];

type Runtime = { db: DatabaseSync; timers: Map<string, NodeJS.Timeout>; choosing: Set<string> };
const globals = globalThis as typeof globalThis & { hexArena?: Runtime };
function runtime() {
  if (!globals.hexArena) {
    const path = resolve(process.env.HEX_DB_PATH || '.data/hex.sqlite');
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner, created DESC);
    `);
    globals.hexArena = { db, timers: new Map(), choosing: new Set() };
  }
  return globals.hexArena;
}

function save(owner: string, run: LabRun) {
  runtime().db.prepare(`
    INSERT INTO runs VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot WHERE owner = excluded.owner
  `).run(run.id, owner, run.createdAt, JSON.stringify(run));
}

export function getRun(owner: string, id: string) {
  const row = runtime().db.prepare('SELECT snapshot FROM runs WHERE owner = ? AND id = ?').get(owner, id);
  return row ? JSON.parse(String(row.snapshot)) as LabRun : undefined;
}

export function listRuns(owner: string): RunSummary[] {
  const rows = runtime().db.prepare('SELECT snapshot FROM runs WHERE owner = ? ORDER BY created DESC, rowid DESC LIMIT 20').all(owner);
  return rows.map(({ snapshot }) => {
    const { id, createdAt, phase } = JSON.parse(String(snapshot)) as LabRun;
    return { id, createdAt, phase };
  });
}

function message(run: LabRun, draft: Omit<Msg, 'id' | 'time'>) {
  run.messages.push({ ...draft, id: run.messages.length + 1, time: new Date().toISOString() });
}

// One crafted lookup against the synthetic endpoint, recorded as evidence and as a feed message.
function applyAttack(run: LabRun, kind: Attack['kind'], d: { payload: string; why: string; source: Attack['source']; status: number; names: string[]; leaked: boolean }) {
  const n = (run.sqlAttempts ??= []).filter((a) => a.kind === kind).length + 1;
  const attack: Attack = {
    kind, payload: d.payload, rationale: d.why, source: d.source,
    status: d.status, rows: d.names.length, names: d.names, outcome: d.leaked ? 'leaked' : 'blocked',
  };
  run.sqlAttempts.push(attack);
  run.attempts += 1;
  message(run, {
    agent: 'Injector', squad: 'red', source: d.source, findingId: 'sql', status: d.leaked ? 'success' : undefined,
    text: (kind === 'attempt' ? 'Attempt ' : 'Re-attack ') + n + ': `' + d.payload + '` → '
      + (d.leaked ? 'leaked ' + d.names.join(', ') : 'blocked (HTTP ' + d.status + ')'),
  });
  return attack;
}

function sendPayload(payload: string, hardened: boolean) {
  const ev = probe('sql', hardened, false, undefined, false, undefined, payload);
  const names = ((ev.response as { rows?: { name: string }[] }).rows ?? []).map((row) => row.name);
  return { ev, names, status: ev.status, leaked: exposed('sql', ev) };
}

function openSqlFinding(run: LabRun, before: ReturnType<typeof sendPayload>, payload: string) {
  const meta = checks.find((c) => c.id === 'sql')!;
  run.findings.push({
    id: 'sql', agent: meta.agent, title: meta.title, severity: meta.severity,
    before: before.ev, payload, openedAt: Date.now(), state: 'Open',
    attacks: run.sqlAttempts!.filter((a) => a.kind === 'attempt'),
  });
  message(run, { agent: meta.agent, squad: 'red', status: 'success', findingId: 'sql', text: meta.title + ' confirmed from the target response.' });
  message(run, { agent: 'Sentinel', squad: 'blue', status: 'alert', findingId: 'sql', text: 'Response inspection detected synthetic data outside the intended trust boundary.' });
}

// Offline Red: walk the built-in payloads until one leaks, then open the finding.
function localSqlAttempts(run: LabRun) {
  const sentAt = performance.now();
  for (let i = 0; i < 3; i++) {
    const { payload, why } = localSqlPayloads[i];
    const result = sendPayload(payload, false);
    applyAttack(run, 'attempt', { payload, why, source: 'Local', status: result.status, names: result.names, leaked: result.leaked });
    if (result.leaked) {
      run.detectMs.push(Number((performance.now() - sentAt).toFixed(3)));
      openSqlFinding(run, result, payload);
      return;
    }
  }
  message(run, { agent: 'Injector', squad: 'red', findingId: 'sql', text: 'The customer lookup resisted 3 crafted payloads.' });
}

function reattackSql(run: LabRun, payloads: { payload: string; why: string }[], source: Attack['source']) {
  const finding = run.findings.find((f) => f.id === 'sql');
  if (!finding) return;
  let broke = false;
  for (const { payload, why } of payloads) {
    const result = sendPayload(payload, true);
    const attack = applyAttack(run, 'reattack', { payload, why, source, status: result.status, names: result.names, leaked: result.leaked });
    (finding.attacks ??= []).push(attack);
    broke ||= result.leaked;
  }
  if (broke) {
    finding.state = 'Rolled back';
    finding.verifiedAt = undefined;
    message(run, { agent: 'Injector', squad: 'red', status: 'alert', findingId: 'sql', text: 'Red re-attacked and a new payload still leaked. The fix was rolled back.' });
  } else {
    message(run, { agent: 'Injector', squad: 'red', status: 'success', findingId: 'sql', text: 'Red re-attacked with 2 new payloads: all blocked.' });
  }
}

function needsReattack(run: LabRun) {
  return run.findings.find((f) => f.id === 'sql' && f.state === 'Verified'
    && f.verification?.some((v) => v.policy === 'scoped' && v.passed) && !f.attacks?.some((a) => a.kind === 'reattack'));
}

function verifyFinding(run: LabRun, id: ProbeId, quarantine = false) {
  const finding = run.findings.find((item) => item.id === id && item.state !== 'Verified');
  if (!finding) return;
  const order = leakedOrder(run.findings.find((item) => item.id === 'sql')?.before);
  finding.replay = probe(id, true, false, order, quarantine, finding.variant);
  finding.control = probe(id, true, true, undefined, quarantine);
  const passed = verified(id, finding.replay, finding.control);
  (finding.verification ??= []).push({ policy: quarantine ? 'quarantine' : 'scoped', passed, replay: finding.replay, control: finding.control });
  if (passed) {
    finding.state = 'Verified';
    finding.verifiedAt = Date.now();
    message(run, {
      agent: 'Verifier', squad: 'neutral', status: 'blocked', findingId: id,
      text: finding.title + ' is mitigated. The attack replay was blocked and the legitimate control still passed.',
    });
  } else {
    finding.state = 'Rolled back';
    message(run, {
      agent: 'Verifier', squad: 'neutral', status: 'alert', findingId: id,
      text: finding.title + ' failed the replay or legitimate control. The candidate policy was rolled back.' +
        (quarantine ? ' The legitimate request returned 503 while the route was quarantined.' : ''),
    });
  }
}

function schedule(owner: string, run: LabRun) {
  const { timers } = runtime();
  clearTimeout(timers.get(run.id));
  timers.delete(run.id);
  if (run.phase !== 'running' || runtime().choosing.has(run.id)) return;
  const timer = setTimeout(() => {
    timers.delete(run.id);
    advance(owner, run.id);
  }, Math.max(0, run.nextAt - Date.now()));
  timer.unref();
  timers.set(run.id, timer);
}

function enrich(owner: string, id: string, run: LabRun, room: number) {
  const facts = run.findings.map(({ id, title, severity, before }) => ({ id, title, severity, status: before.status }));
  void Promise.all([
    room >= 1 ? explain('Scout, the red team analyst. Focus on how the crafted lookup leak informs the order probe', facts, '') : Promise.resolve({ text: '', source: 'Local' as const }),
    room >= 2 ? explain('Triage, the blue team analyst. Focus on severity and prioritization', facts, '') : Promise.resolve({ text: '', source: 'Local' as const }),
    Promise.all(facts.map(async (fact) => ({ id: fact.id, value: await escalationSignal(fact) }))),
  ]).then(([scout, triage, signals]) => {
    const current = getRun(owner, id);
    if (!current) return;
    for (const signal of signals) {
      const finding = current.findings.find((item) => item.id === signal.id);
      if (finding && signal.value !== undefined) finding.escalation = signal.value;
    }
    if (scout.text) message(current, { agent: 'Scout', squad: 'red', ...scout });
    if (triage.text) message(current, { agent: 'Triage', squad: 'blue', ...triage });
    save(owner, current);
  }).catch(console.error);
}

export function advance(owner: string, id: string) {
  const run = getRun(owner, id);
  if (!run || run.phase !== 'running' || run.nextAt > Date.now()) {
    if (run?.phase === 'running' && !runtime().timers.has(id)) schedule(owner, run);
    return run;
  }
  if (run.agentWork) {
    advanceAgents(owner, run);
    return run;
  }
  let enrichRoom = 0;
  try {
    const check = checks[run.step];
    if (check) {
      if (check.id === 'sql') localSqlAttempts(run);
      else executeProbe(run, check);
    } else if (run.step === checks.length) {
      message(run, {
        agent: 'Triage', squad: 'blue',
        text: run.findings.length + ' exposures correlated from measured responses. Testing runtime policies against attack replays and legitimate traffic.',
      });
      enrichRoom = 2;
    } else if (run.step === checks.length + 1) {
      verifyFinding(run, 'sql');
      if (needsReattack(run)) reattackSql(run, localReattackPayloads, 'Local');
      verifyFinding(run, 'prompt');
      for (const check of modernChecks) verifyFinding(run, check.id);
      if (run.findings.some((finding) => finding.id === 'ownership' && finding.state === 'Open')) {
        requestApproval(run);
      } else {
        complete(run);
      }
    }
    run.step += 1;
    run.nextAt = Date.now() + 950;
  } catch (error) {
    console.error(error);
    run.phase = 'failed';
    message(run, { agent: 'Director', squad: 'neutral', status: 'alert', text: 'A lab tool failed. Captured evidence is available in Findings.' });
  }
  save(owner, run);
  schedule(owner, run);
  if (enrichRoom) enrich(owner, id, run, 0);
  return run;
}

function executeProbe(run: LabRun, check: typeof checks[number], variant?: 'alternate') {
  const sentAt = performance.now();
  const order = leakedOrder(run.findings.find((item) => item.id === 'sql')?.before);
  const before = probe(check.id, false, false, order, false, variant);
  run.attempts += 1;
  if (exposed(check.id, before)) {
    run.detectMs.push(Number((performance.now() - sentAt).toFixed(3)));
    run.findings.push({ id: check.id, agent: check.agent, title: check.title, severity: check.severity, before, variant, openedAt: Date.now(), state: 'Open' });
    message(run, {
      agent: check.agent, squad: 'red', status: 'success', findingId: check.id,
      text: check.title + ' confirmed from the target response.' + check.note
        + (check.id === 'ownership' && order ? ' This probe used the order ID discovered by Injector.' : '')
        + (check.id === 'prompt' ? ' This is a deterministic fixture.' : ''),
    });
    message(run, {
      agent: 'Sentinel', squad: 'blue', status: 'alert', findingId: check.id,
      text: 'Response inspection detected synthetic data outside the intended trust boundary.',
    });
  } else {
    message(run, { agent: check.agent, squad: 'red', findingId: check.id, text: 'Probe completed without a confirmed exposure.' + (check.id === 'prompt' ? ' This is a deterministic fixture.' : '') });
  }
}

function requestApproval(run: LabRun) {
  run.phase = 'approval';
  run.approvalRequestedAt = Date.now();
  message(run, {
    agent: 'Containment', squad: 'blue', approval: true, findingId: 'ownership',
    text: 'The ownership policy changes access to orders. Approve the targeted fix or leave this finding open.',
  });
}

// Guarded async turn: mirrors the lock, snapshot check, failure and reschedule used by the option loop.
function agentCycle(owner: string, run: LabRun, fn: (currentTurn: () => LabRun | undefined) => Promise<void>) {
  const choosing = runtime().choosing;
  choosing.add(run.id);
  const base = { step: run.step, nextAt: run.nextAt };
  const currentTurn = () => {
    const c = getRun(owner, run.id);
    return c?.phase === 'running' && c.step === base.step && c.nextAt === base.nextAt ? c : undefined;
  };
  void fn(currentTurn).catch((error: unknown) => {
    console.error('Hex agent turn failed', error);
    const current = getRun(owner, run.id);
    if (!current) return;
    current.phase = 'failed';
    message(current, {
      agent: 'Director', squad: 'neutral', status: 'alert',
      text: 'The agent turn failed. Check the server log and AI provider configuration, then start a new run. Existing evidence is saved.',
    });
    save(owner, current);
  }).finally(() => {
    choosing.delete(run.id);
    const current = getRun(owner, run.id);
    if (current) schedule(owner, current);
  });
}

async function craftSequence(startCalls: number, count: number, hardened: boolean, goal: string, fallback: typeof localSqlPayloads) {
  let used = 0;
  const done: { payload: string; why: string; source: Attack['source']; status: number; names: string[]; leaked: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    let payload: string | undefined;
    let why = '';
    let source: Attack['source'] = 'Local';
    if (startCalls + used < AI_BUDGET) {
      used++;
      const crafted = await craftPayload('/customers lookup', done.map((d) => ({ payload: d.payload, status: d.status, rows: d.names.length, names: d.names })), goal);
      if (crafted) { payload = crafted.payload; why = crafted.rationale; source = providerName() ?? 'Local'; }
    }
    if (payload === undefined) { const f = fallback[i % fallback.length]; payload = f.payload; why = f.why; }
    const result = sendPayload(payload, hardened);
    done.push({ payload, why, source, status: result.status, names: result.names, leaked: result.leaked });
    if (!hardened && result.leaked) break;
  }
  return { used, done };
}

function advanceAgents(owner: string, run: LabRun) {
  const choosing = runtime().choosing;
  if (choosing.has(run.id)) return;
  const work = run.agentWork!;
  const order = leakedOrder(run.findings.find((finding) => finding.id === 'sql')?.before);

  // Red, step 1: adaptive SQL attempts (crafted while budget allows, otherwise built-in payloads).
  if (work.stage === 'red' && !run.sqlAttempts?.some((a) => a.kind === 'attempt')) {
    return agentCycle(owner, run, async (currentTurn) => {
      const { used, done } = await craftSequence(run.aiCalls ?? 0, 3, false, GOAL_ATTEMPT, localSqlPayloads);
      const current = currentTurn();
      if (!current?.agentWork) return;
      current.aiCalls = (current.aiCalls ?? 0) + used;
      for (const d of done) applyAttack(current, 'attempt', d);
      const hit = done.find((d) => d.leaked);
      if (hit) {
        current.detectMs.push(0);
        openSqlFinding(current, { ev: probe('sql', false, false, undefined, false, undefined, hit.payload), names: hit.names, status: hit.status, leaked: true }, hit.payload);
      } else {
        message(current, { agent: 'Injector', squad: 'red', findingId: 'sql', text: 'The customer lookup resisted ' + done.length + ' crafted payloads.' });
      }
      current.step += 1;
      current.nextAt = Date.now() + 500;
      save(owner, current);
    });
  }

  // Red re-attack: after a scoped SQL fix verifies, probe the hardened endpoint with new payloads.
  const verifiedSql = needsReattack(run);
  if (verifiedSql) {
    return agentCycle(owner, run, async (currentTurn) => {
      const { used, done } = await craftSequence(run.aiCalls ?? 0, 2, true, GOAL_REATTACK, localReattackPayloads);
      const current = currentTurn();
      if (!current?.agentWork) return;
      current.aiCalls = (current.aiCalls ?? 0) + used;
      const finding = current.findings.find((f) => f.id === 'sql')!;
      let broke = false;
      for (const d of done) { const attack = applyAttack(current, 'reattack', d); (finding.attacks ??= []).push(attack); broke ||= d.leaked; }
      if (broke) {
        finding.state = 'Rolled back';
        finding.verifiedAt = undefined;
        message(current, { agent: 'Injector', squad: 'red', status: 'alert', findingId: 'sql', text: 'Red re-attacked and a new payload still leaked. The fix was rolled back.' });
      } else {
        message(current, { agent: 'Injector', squad: 'red', status: 'success', findingId: 'sql', text: 'Red re-attacked with 2 new payloads: all blocked.' });
      }
      current.step += 1;
      current.nextAt = Date.now() + 500;
      save(owner, current);
    });
  }

  // Red follow-ups are deterministic fixtures and need no model call.
  if (work.stage === 'red') {
    const next = [checks[2], ...(order ? [checks[1]] : []), ...modernChecks].find((check) => !run.messages.some((m) => m.agent === check.agent));
    if (next) {
      executeProbe(run, next);
    } else {
      work.stage = 'blue';
      const room = Math.max(0, Math.min(2, AI_BUDGET - (run.aiCalls ?? 0)));
      run.aiCalls = (run.aiCalls ?? 0) + room;
      message(run, { agent: 'Triage', squad: 'blue', text: 'Red has handed over ' + run.findings.length + ' measured findings for policy selection.' });
      run.step += 1;
      run.nextAt = Date.now() + 500;
      save(owner, run);
      schedule(owner, run);
      enrich(owner, run.id, run, room);
      return;
    }
    run.step += 1;
    run.nextAt = Date.now() + 500;
    save(owner, run);
    schedule(owner, run);
    return;
  }

  // Blue: choose a candidate policy for each confirmed, not-yet-fixed finding.
  const options = run.findings
    .filter((f) => f.state !== 'Verified' && !f.attacks?.some((a) => a.kind === 'reattack'))
    .flatMap(({ id, title }) => [
      { action: 'fix_' + id, id, description: 'Apply the scoped runtime fix for ' + title + ' (' + checks.find((check) => check.id === id)!.fix + ')' },
      ...(id === 'ownership' ? [] : [{ action: 'quarantine_' + id, id, description: 'Quarantine the entire route for ' + title + ', including normal traffic' }]),
    ])
    .filter(({ action }) => !work.decisions.some((d) => d.action === action));

  if (!options.length) {
    complete(run);
    save(owner, run);
    schedule(owner, run);
    return;
  }

  const applyBlue = (current: LabRun, action: string, reason: string, source: Msg['source']) => {
    const selected = options.find((o) => o.action === action)!;
    current.agentWork!.decisions.push({ action, reason, agent: 'Patch Engineer', time: new Date().toISOString() });
    message(current, { agent: 'Patch Engineer', squad: 'blue', source, text: selected.description + '. ' + reason });
    if (selected.id === 'ownership') requestApproval(current);
    else verifyFinding(current, selected.id, action.startsWith('quarantine_'));
    current.step += 1;
    current.nextAt = Date.now() + 500;
    save(owner, current);
  };

  // Budget spent: apply the first scoped fix deterministically so the run always finishes.
  if ((run.aiCalls ?? 0) >= AI_BUDGET) {
    const scoped = options.find((o) => o.action.startsWith('fix_')) ?? options[0];
    applyBlue(run, scoped.action, 'Budget reached; applied the scoped fix deterministically.', 'Local');
    schedule(owner, run);
    return;
  }

  run.aiCalls = (run.aiCalls ?? 0) + 1;
  save(owner, run);
  agentCycle(owner, run, async (currentTurn) => {
    const decision = await chooseAction(
      'You are Patch Engineer. Choose a candidate policy that closes a confirmed exposure while preserving legitimate traffic. Learn from previous verifier results.',
      options.map(({ action, description }) => ({ action, description })),
      {
        stage: 'blue',
        discoveredOrder: order,
        findings: run.findings.map(({ id, state, before, replay, control }) => ({ id, state, before, replay, control })),
        previousActions: work.decisions.map(({ action }) => action),
      },
    );
    const current = currentTurn();
    if (!current?.agentWork) return;
    const selected = decision && options.find(({ action }) => action === decision.action);
    if (!decision || !selected) throw new Error('AI agent did not select an available tool');
    applyBlue(current, selected.action, decision.reason, providerName() ?? 'Local');
  });
}

function complete(run: LabRun) {
  run.phase = 'complete';
  const count = run.findings.filter((item) => item.state === 'Verified').length;
  message(run, {
    agent: 'Director', squad: 'neutral',
    text: 'Run complete. ' + count + ' of ' + run.findings.length + ' findings have a verified mitigation.',
  });
}

export function startRun(owner: string) {
  const run: LabRun = {
    id: randomUUID(), createdAt: Date.now(), phase: 'running', step: 0, nextAt: Date.now() + 800,
    approved: null, messages: [], findings: [], attempts: 0, detectMs: [], aiCalls: 0, sqlAttempts: [],
    ...(providerName() ? { agentWork: { provider: providerName(), stage: 'red' as const, decisions: [] } } : {}),
  };
  message(run, { agent: 'Scout', squad: 'red', text: 'Synthetic Atlas Commerce target scoped to customer lookup, order ownership, the refund assistant, link previews, settings sync and the dependency pipeline.' });
  message(run, {
    agent: 'Director', squad: 'neutral',
    text: run.agentWork ? run.agentWork.provider + ' agent mode. Red crafts probes, Blue selects policies, and Verifier checks the results.'
      : 'Local practice mode. Add an OpenAI or Groq key and start a new run for agent-crafted probes and policies.',
  });
  save(owner, run);
  schedule(owner, run);
  return run;
}

export function updateRun(owner: string, id: string, action: string) {
  const run = getRun(owner, id);
  if (!run) return;
  if (action === 'pause' && run.phase === 'running') run.phase = 'paused';
  if (action === 'resume' && run.phase === 'paused') {
    run.phase = 'running';
    run.nextAt = Date.now() + 500;
  }
  if ((action === 'approve' || action === 'decline') && run.phase === 'approval') {
    run.approved = action === 'approve';
    run.approvalAnsweredAt = Date.now();
    message(run, {
      agent: 'You', squad: 'you',
      text: run.approved ? 'Apply the order ownership policy.' : 'Leave the order ownership policy unchanged.',
    });
    if (run.approved) verifyFinding(run, 'ownership');
    if (run.agentWork) {
      run.phase = 'running';
      run.nextAt = Date.now() + 500;
    } else {
      complete(run);
    }
  }
  save(owner, run);
  schedule(owner, run);
  return run;
}

export async function directive(owner: string, run: LabRun, input: string) {
  message(run, { agent: 'You', squad: 'you', text: input });
  save(owner, run);
  const verifiedCount = run.findings.filter((item) => item.state === 'Verified').length;
  const reply = await explain('Director', {
    directive: input, phase: run.phase,
    findings: run.findings.map(({ title, state }) => ({ title, state })),
  }, 'Phase: ' + run.phase + '. ' + run.findings.length + ' confirmed findings and ' + verifiedCount + ' verified mitigations. Your directive was recorded.');
  const current = getRun(owner, run.id);
  if (!current) return;
  message(current, { agent: 'Director', squad: 'neutral', ...reply });
  save(owner, current);
  return current;
}

export function receipt(run: LabRun) {
  const evidence = { schema: 2, run: run.id, createdAt: run.createdAt, findings: run.findings, attacks: run.sqlAttempts, decisions: run.agentWork?.decisions };
  return { evidence, sha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}

export type { Finding };
