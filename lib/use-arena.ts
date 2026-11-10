'use client';

import { useEffect, useRef, useState } from 'react';
import type { LabRun, RunSummary } from './lab-types';

type Snapshot = { run: LabRun | null; runs: RunSummary[] };

async function request(id?: string, action?: string, message?: string): Promise<Snapshot> {
  const response = await fetch('/api/arena' + (!action && id ? '?id=' + encodeURIComponent(id) : ''), {
    cache: 'no-store',
    ...(action ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, message }),
    } : {}),
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Arena request failed.');
  return result;
}

export function useArena() {
  const [run, setRun] = useState<LabRun | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const id = run?.id;

  useEffect(() => {
    if (busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        let next = await request(id);
        if (!id && next.runs[0]) next = await request(next.runs[0].id);
        if (cancelled || pending.current) return;
        setRun(next.run);
        setRuns(next.runs);
        setRefreshError('');
      } catch (failure) {
        if (!cancelled && !pending.current) setRefreshError(failure instanceof Error ? failure.message : 'Arena unavailable.');
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 1200);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, busy]);

  async function act(action: string, text?: string, selected?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const next = await request(selected ?? id, action === 'open' ? undefined : action, text);
      setRun(next.run);
      setRuns(next.runs);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Arena unavailable.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const findings = run?.findings ?? [];
  const patched = findings.filter((item) => item.state === 'Verified');
  // Exclude the operator's approval wait so "Mean patch" measures the agents, not the human.
  const approvalWait = run?.approvalRequestedAt && run.approvalAnsweredAt
    ? run.approvalAnsweredAt - run.approvalRequestedAt : 0;
  const patchTimes = patched.map((item) => {
    const elapsed = (item.verifiedAt ?? item.openedAt) - item.openedAt;
    return item.id === 'ownership' ? Math.max(0, elapsed - approvalWait) : elapsed;
  });
  function mean(values: number[]) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  return {
    run, runs, error: error || refreshError, busy, findings,
    messages: run?.messages ?? [],
    running: run?.phase === 'running',
    typing: run?.phase === 'running'
      ? run.agentWork
        ? (run.agentWork.stage === 'red' ? 'Scout' : 'Patch Engineer')
        : ['Injector', 'IDOR Runner', 'Prompt Smuggler', 'Triage', 'Patch Engineer'][run.step]
      : '',
    stats: {
      attacks: run?.attempts ?? 0,
      caught: findings.length,
      patched: patched.length,
      detectMs: mean(run?.detectMs ?? []),
      patchMs: mean(patchTimes),
      waitingMs: approvalWait || (run?.approvalRequestedAt && !run.approvalAnsweredAt ? Date.now() - run.approvalRequestedAt : null),
      aiCalls: run?.aiCalls ?? 0,
    },
    reset: () => act('start'),
    open: (selected: string) => act('open', undefined, selected),
    setRunning: (next: boolean) => act(next ? (run?.phase === 'paused' ? 'resume' : 'start') : 'pause'),
    choose: (allow: boolean) => act(allow ? 'approve' : 'decline'),
    sendDirective: (text: string) => act('directive', text),
  };
}
