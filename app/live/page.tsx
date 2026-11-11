'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, GitCommitHorizontal, Loader2, RefreshCw, Webhook, XCircle, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Logo } from '../../components/agent-identity';
import { ProjectReviewResults } from '../../components/project-review-results';
import type { LiveConfig, LiveFinding, LivePush, LivePushSummary, LiveStatus } from '../../lib/live-types';

const statusLabel: Record<LiveStatus, string> = { queued: 'Queued', running: 'Reviewing', passed: 'Passed', failed: 'Failed', error: 'Error' };

function StatusIcon({ status }: { status: LiveStatus }) {
  if (status === 'passed') return <CheckCircle2 size={16} />;
  if (status === 'failed') return <XCircle size={16} />;
  if (status === 'error') return <AlertTriangle size={16} />;
  if (status === 'running') return <Loader2 size={16} className="live-spin" />;
  return <CircleDashed size={16} />;
}

function ago(time?: number) {
  if (!time) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  return new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function FindingList({ items, empty }: { items: LiveFinding[]; empty: string }) {
  if (!items.length) return <p className="live-muted">{empty}</p>;
  return (
    <ul className="live-findings">
      {items.slice(0, 20).map((item) => (
        <li key={item.file + item.line + item.title}>
          <span className={'live-sev ' + item.severity.toLowerCase()}>{item.severity}</span>
          <span>{item.title}</span>
          <code>{item.file}:{item.line}</code>
        </li>
      ))}
      {items.length > 20 && <li className="live-muted">…and {items.length - 20} more</li>}
    </ul>
  );
}

function PushDetail({ push }: { push: LivePushSummary }) {
  const [full, setFull] = useState<{ push: LivePush; archive?: string }>();
  const [loading, setLoading] = useState(false);
  const summary = push.summary;

  async function openReport() {
    setLoading(true);
    try {
      const response = await fetch('/api/live?archive=1&id=' + push.id);
      if (response.ok) setFull(await response.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="live-detail">
      {push.status === 'running' && (
        <ol className="live-log">
          {push.updates.map((update, i) => <li key={i} className={update.squad}><b>{update.agent}</b> {update.text}</li>)}
        </ol>
      )}
      {push.error && <p className="landing-error">{push.error}</p>}
      {summary && (
        <div className="live-columns">
          <section>
            <h3>{summary.baseline ? 'Baseline findings' : 'Introduced by this push'}</h3>
            {summary.baseline
              ? <p className="live-muted">First review of this branch. Later pushes are compared with this one.</p>
              : <FindingList items={summary.introduced} empty="Nothing new. This push added no findings." />}
          </section>
          <section>
            <h3>Fixed by this push</h3>
            <FindingList items={summary.fixed} empty={summary.baseline ? 'Nothing to compare yet.' : 'No earlier findings disappeared.'} />
          </section>
        </div>
      )}
      <dl className="live-facts">
        {push.githubStatus && <><dt>GitHub status</dt><dd>{push.githubStatus}</dd></>}
        {push.githubComment && <><dt>Commit comment</dt><dd>{push.githubComment}</dd></>}
        {summary?.ai && <><dt>AI review</dt><dd>{summary.ai}</dd></>}
        <dt>Trigger</dt><dd>{push.trigger === 'poll' ? 'Poller' : push.trigger === 'webhook' ? 'Webhook' : 'Manual'}</dd>
        {push.startedAt && push.finishedAt && <><dt>Duration</dt><dd>{((push.finishedAt - push.startedAt) / 1000).toFixed(1)}s</dd></>}
      </dl>
      {push.hasReport && !full && (
        <button className="ghost" disabled={loading} onClick={openReport}>{loading ? 'Loading report…' : 'Open full report'}</button>
      )}
      {full?.push.report && full.archive && (
        <div className="pr live-report">
          <ProjectReviewResults
            review={{ report: full.push.report, archive: full.archive, filename: push.repo.replace('/', '-') + '-' + push.sha.slice(0, 7) }}
            updates={full.push.updates}
          />
        </div>
      )}
    </div>
  );
}

export default function LivePage() {
  const [config, setConfig] = useState<LiveConfig>();
  const [pushes, setPushes] = useState<LivePushSummary[]>([]);
  const [open, setOpen] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/live', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json() as { config: LiveConfig; pushes: LivePushSummary[] };
      setConfig(data.config);
      setPushes(data.pushes);
      setError('');
    } catch {
      setError('The live monitor could not be reached.');
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    const selected = new URLSearchParams(window.location.search).get('push');
    if (selected) setOpen(selected);
    void load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function checkNow() {
    setChecking(true);
    try {
      const response = await fetch('/api/live', { method: 'POST' });
      if (response.ok) {
        const data = await response.json() as { config: LiveConfig; pushes: LivePushSummary[] };
        setConfig(data.config);
        setPushes(data.pushes);
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="shell landing">
      <header>
        <Link href="/"><Logo /></Link>
        <div className="headActions">
          <Link className="ghost" href="/">Home</Link>
          <Link className="ghost" href="/war-room">War room</Link>
        </div>
      </header>
      <section className="landing-body">
        <div className="landing-hero">
          <span className="eyebrow">LIVE GITHUB MONITOR</span>
          <h1>Every push, reviewed</h1>
          <p>Hex reviews each new commit on the repositories it watches, compares it with the previous review of that branch, and reports the result on the commit in GitHub.</p>
        </div>

        <section className="landing-card live-config" aria-labelledby="live-config-heading">
          <div className="live-configHead">
            <h2 id="live-config-heading">Monitor</h2>
            <button className="ghost" disabled={checking || !config?.watching.length} onClick={checkNow}>
              <RefreshCw size={14} className={checking ? 'live-spin' : ''} /> {checking ? 'Checking…' : 'Check for pushes now'}
            </button>
          </div>
          {config && (
            <dl className="live-facts">
              <dt>Watching</dt>
              <dd>{config.watching.length ? config.watching.join(', ') : <>Nothing yet. Add <code>HEX_WATCH_REPOS=owner/repo</code> to <code>.env</code> and restart.</>}</dd>
              <dt>Poller</dt>
              <dd>{config.watching.length ? 'Every ' + config.pollSeconds + 's · last check ' + ago(config.lastPoll) : 'Off'}{config.pollError && <span className="live-warn"> · {config.pollError}</span>}</dd>
              <dt>Webhook</dt>
              <dd>
                <Webhook size={13} /> <code>{origin}/api/github/webhook</code> · {config.webhook ? 'secret configured' : <span className="live-warn">set GITHUB_WEBHOOK_SECRET to enable</span>}
              </dd>
              <dt>Results on GitHub</dt>
              <dd>{config.token ? 'Commit status and comment via GITHUB_TOKEN' : <span className="live-warn">Add GITHUB_TOKEN to post commit statuses</span>}</dd>
              <dt>AI review</dt>
              <dd>{config.ai ?? 'Off (scanner and supply-chain checks only)'}</dd>
            </dl>
          )}
          {error && <p className="landing-error" role="alert">{error}</p>}
        </section>

        <section className="live-list" aria-label="Recent pushes">
          {!pushes.length && <p className="live-muted">No pushes reviewed yet. Push a commit to a watched repository, or press “Check for pushes now”.</p>}
          {pushes.map((push) => {
            const expanded = open === push.id;
            const s = push.summary;
            return (
              <article key={push.id} className={'live-push ' + push.status}>
                <button className="live-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : push.id)}>
                  <span className={'live-pill ' + push.status}><StatusIcon status={push.status} /> {statusLabel[push.status]}</span>
                  <span className="live-commit">
                    <b>{push.message || '(no message)'}</b>
                    <small><GitCommitHorizontal size={12} /> {push.repo}@{push.branch} · <code>{push.sha.slice(0, 7)}</code>{push.author && ' · ' + push.author} · {ago(push.receivedAt)}</small>
                  </span>
                  <span className="live-counts">
                    {s ? (s.baseline ? s.total + ' baseline' : <>{s.introduced.length} new · {s.fixed.length} fixed</>) : ''}
                  </span>
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {expanded && <PushDetail push={push} />}
              </article>
            );
          })}
        </section>
      </section>
    </main>
  );
}
