import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Msg } from '../agents';
import type { LabRun, ProbeId, RunSummary } from '../lab-types';
import { escalationSignal, explain } from './intelligence';
import { chooseAction } from './agent-tools';
import { exposed, leakedOrder, probe, verified } from './target';

const checks = [
  { id: 'sql', agent: 'Injector', title: 'Unbounded customer lookup', severity: 'Critical' },
  { id: 'ownership', agent: 'IDOR Runner', title: 'Cross-account order access', severity: 'High' },
  { id: 'prompt', agent: 'Prompt Smuggler', title: 'Private refund code exposure', severity: 'High' },
] as const;

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

function enrich(owner: string, id: string, run: LabRun) {
  const facts = run.findings.map(({ id, title, severity, before }) => ({ id, title, severity, status: before.status }));
  void Promise.all([
    Promise.all([
      explain('Scout, the red team analyst. Focus on the link between the lookup leak and the order probe', facts, ''),
      explain('Triage, the blue team analyst. Focus on severity and prioritization', facts, ''),
    ]),
    Promise.all(facts.map(async (fact) => ({ id: fact.id, value: await escalationSignal(fact) }))),
  ]).then(([[scout, triage], signals]) => {
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
  let shouldEnrich = false;
  try {
    const check = checks[run.step];
    if (check) {
      executeProbe(run, check);
    } else if (run.step === checks.length) {
      message(run, {
        agent: 'Triage', squad: 'blue',
        text: run.findings.length + ' exposures correlated from measured responses. Testing runtime policies against attack replays and legitimate traffic.',
      });
      shouldEnrich = true;
    } else if (run.step === checks.length + 1) {
      verifyFinding(run, 'sql');
      verifyFinding(run, 'prompt');
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
  if (shouldEnrich) enrich(owner, id, run);
  return run;
}

function executeProbe(run: LabRun, check: typeof checks[number], variant?: 'alternate') {
      const sentAt = performance.now();
      const order = leakedOrder(run.findings.find((item) => item.id === 'sql')?.before);
      const before = probe(check.id, false, false, order, false, variant);
      run.attempts += 1;
      if (exposed(check.id, before)) {
        run.detectMs.push(Number((performance.now() - sentAt).toFixed(3)));
        run.findings.push({ ...check, before, variant, openedAt: Date.now(), state: 'Open' });
        message(run, {
          agent: check.agent, squad: 'red', status: 'success', findingId: check.id,
          text: check.title + ' confirmed from the target response.' +
            (check.id === 'ownership' && order ? ' This probe used the order ID discovered by Injector.' : ''),
        });
        message(run, {
          agent: 'Sentinel', squad: 'blue', status: 'alert', findingId: check.id,
          text: 'Response inspection detected synthetic data outside the intended trust boundary.',
        });
      } else {
        message(run, { agent: check.agent, squad: 'red', text: 'Probe completed without a confirmed exposure.' });
      }
}

function requestApproval(run: LabRun) {
  run.phase = 'approval';
  message(run, {
    agent: 'Containment', squad: 'blue', approval: true, findingId: 'ownership',
    text: 'The ownership policy changes access to orders. Approve the targeted fix or leave this finding open.',
  });
}

function advanceAgents(owner: string, run: LabRun) {
  const work = run.agentWork!;
  const choosing = runtime().choosing;
  if (choosing.has(run.id)) return;

  const order = leakedOrder(run.findings.find((item) => item.id === 'sql')?.before);
  const tried = new Set(work.decisions.map(({ action }) => action));
  const red = work.stage === 'red';
  const options: { action: string; id: ProbeId; description: string; variant?: 'alternate' }[] = red
    ? checks.filter(({ id }) => !run.findings.some((finding) => finding.id === id) && (id !== 'ownership' || order))
        .flatMap(({ id, title }) => [
          { action: id, id, description: 'Test ' + title + ' with the baseline payload' },
          ...(id === 'ownership' ? [] : [{
            action: id + '_alternate', id, variant: 'alternate' as const,
            description: id === 'sql' ? 'Test the customer query with a UNION payload'
              : 'Test the refund assistant with a system override payload',
          }]),
        ]).filter(({ action }) => !tried.has(action))
    : run.findings.filter(({ state }) => state !== 'Verified').flatMap(({ id, title }) => [
        { action: 'fix_' + id, id, description: 'Apply the scoped runtime fix for ' + title },
        ...(id === 'ownership' ? [] : [
          { action: 'quarantine_' + id, id, description: 'Quarantine the entire route for ' + title + ', including normal traffic' },
        ]),
      ]).filter(({ action }) => !tried.has(action));

  if (!options.length) {
    if (red) {
      work.stage = 'blue';
      message(run, {
        agent: 'Triage', squad: 'blue',
        text: 'Red has handed over ' + run.findings.length + ' measured findings for policy selection.',
      });
      run.nextAt = Date.now() + 500;
    } else {
      complete(run);
    }
    save(owner, run);
    schedule(owner, run);
    if (red) enrich(owner, run.id, run);
    return;
  }

  const agent = red ? 'Scout' : 'Patch Engineer';
  choosing.add(run.id);
  const currentTurn = () => {
    const current = getRun(owner, run.id);
    return current?.phase === 'running' && current.step === run.step && current.nextAt === run.nextAt
      ? current : undefined;
  };
  void chooseAction(
    red
      ? 'You are Scout coordinating the red agents. Choose what to probe next using shared evidence.'
      : 'You are Patch Engineer. Choose a candidate policy that closes a confirmed exposure while preserving legitimate traffic. Learn from previous verifier results.',
    options.map(({ action, description }) => ({ action, description })),
    {
      stage: work.stage,
      discoveredOrder: order,
      findings: run.findings.map(({ id, state, before, replay, control }) => ({ id, state, before, replay, control })),
      previousActions: work.decisions.map(({ action }) => action),
    },
  ).then((decision) => {
    const current = currentTurn();
    if (!current?.agentWork) return;
    const selected = options.find(({ action }) => action === decision?.action);
    if (!decision || !selected) throw new Error('OpenAI agent did not select an available tool');

    current.agentWork.decisions.push({ ...decision, agent, time: new Date().toISOString() });
    message(current, {
      agent, squad: red ? 'red' : 'blue', source: 'OpenAI',
      text: selected.description + '. ' + decision.reason,
    });
    if (red) {
      const check = checks.find(({ id }) => id === selected.id)!;
      executeProbe(current, check, selected.variant);
    } else if (selected.id === 'ownership') {
      requestApproval(current);
    } else {
      verifyFinding(current, selected.id, selected.action.startsWith('quarantine_'));
    }
    current.step += 1;
    current.nextAt = Date.now() + 500;
    save(owner, current);
  }).catch((error: unknown) => {
    console.error('Hex agent turn failed', error);
    const current = currentTurn();
    if (!current) return;
    current.phase = 'failed';
    message(current, {
      agent: 'Director', squad: 'neutral', status: 'alert',
      text: 'The agent turn failed. Check the server log and OpenAI configuration, then start a new run. Existing evidence is saved.',
    });
    save(owner, current);
  }).finally(() => {
    choosing.delete(run.id);
    const current = getRun(owner, run.id);
    if (current) schedule(owner, current);
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
    approved: null, messages: [], findings: [], attempts: 0, detectMs: [],
    ...(process.env.OPENAI_API_KEY ? { agentWork: { stage: 'red', decisions: [] } } : {}),
  };
  message(run, { agent: 'Scout', squad: 'red', text: 'Synthetic Atlas Commerce target scoped to customer lookup, order ownership and the refund assistant.' });
  message(run, {
    agent: 'Director', squad: 'neutral',
    text: run.agentWork ? 'OpenAI agent mode. Red selects probes, Blue selects policies, and Verifier checks the results.'
      : 'Local practice mode. Add an OpenAI key and start a new run for agent-selected probes and policies.',
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
  const evidence = { schema: 1, run: run.id, createdAt: run.createdAt, findings: run.findings, decisions: run.agentWork?.decisions };
  return { evidence, sha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}
