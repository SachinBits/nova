'use client';
import Link from 'next/link';
import { ProjectBattle, projectRoles } from '../../components/project-battle';
import { downloadArchive } from '../../components/project-review-results';
import { useProjectReview } from '../../components/project-review-session';
import { useEffect, useMemo, useRef, useState } from 'react';
import { agents, type Squad } from '../../lib/agents';
import { Logo, Avatar, Stacked } from '../../components/agent-identity';
import { useArena } from '../../lib/use-arena';
import type { Evidence, Finding, LabRun } from '../../lib/lab-types';
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronLeft,
  CircleStop,
  Download,
  Clock3,
  FileCode2,
  ListFilter,
  Moon,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';

export default function WarRoom() {
  const { project } = useProjectReview();
  const [dark, setDark] = useState(true);
  const [active, setActive] = useState('War room');
  const [tab, setTab] = useState<'feed' | 'score' | 'findings' | 'project'>(project ? 'project' : 'feed');
  const [input, setInput] = useState('');
  const [focus, setFocus] = useState(0);
  const inProject = tab === 'project' && !!project;
  const projectAgents = useMemo(() => {
    const seen = new Map<string, { squad: Squad; count: number }>();
    for (const update of project?.updates ?? []) {
      const entry = seen.get(update.agent);
      if (entry) entry.count += 1;
      else seen.set(update.agent, { squad: update.squad, count: 1 });
    }
    return [...seen].map(([name, value]) => ({ name, ...value }));
  }, [project?.updates]);
  // Sidebar choices filter whichever view is open. In the lab they also open the feed they filter.
  function pick(name: string) {
    setActive(name);
    setFocus((count) => count + 1);
    setMobileOpen(false);
    if (!inProject) setTab('feed');
  }
  function switchTab(next: 'feed' | 'score' | 'findings' | 'project') {
    if ((next === 'project') !== (tab === 'project')) setActive('War room');
    setTab(next);
  }
  const [mobileOpen, setMobileOpen] = useState(false);
  const {
    messages,
    running,
    typing,
    run, runs, findings, busy, error, open,
    stats,
    setRunning,
    reset,
    choose,
    sendDirective,
  } = useArena();
  const [selectedFinding, setSelectedFinding] = useState<Finding['id'] | null>(null);
  const detail = findings.find((finding) => finding.id === selectedFinding);
  const end = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  // The landing page opens /war-room?start=1 to begin a lab run straight away.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('start') === '1' && !project) {
      autoStarted.current = true;
      window.history.replaceState(null, '', '/war-room');
      void setRunning(true);
    }
    // setRunning is recreated each render; the ref guard keeps this to a single run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the conversation only when the reader is already near its end.
  useEffect(() => {
    const feed = feedRef.current;
    if (feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 220) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, typing]);

  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = scrollPositions.current[active] ?? feed.scrollHeight;
  }, [active, tab]);

  const filtered = useMemo(() => {
    if (active === 'War room') return messages;
    if (active === 'Red squad')
      return messages.filter(
        (message) => message.squad === 'red' || message.squad === 'neutral',
      );
    if (active === 'Blue squad')
      return messages.filter(
        (message) => message.squad === 'blue' || message.squad === 'neutral',
      );
    return messages.filter((message) => message.agent === active);
  }, [active, messages]);

  function send() {
    const directive = input.trim();
    if (!directive || !run || busy) return;
    setInput('');
    void sendDirective(directive);
  }
  return (
    <main className="shell">
      <aside className={mobileOpen ? 'side open' : 'side'}>
        <div className="brand">
          <Logo />
          <button className="icon" onClick={() => setMobileOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <button
          className="newrun"
          disabled={busy}
          onClick={() => {
            setSelectedFinding(null);
            setTab('feed');
            reset();
            setActive('War room');
          }}
        >
          <Play size={14} fill="currentColor" /> New lab run
        </button>
        <Link href="/" className="thread">
          <FileCode2 size={16} /> <b>Review a project ZIP</b>
        </Link>
        <div className="section">CHANNELS</div>
        {[
          ['War room', 'neutral'],
          ['Red squad', 'red'],
          ['Blue squad', 'blue'],
        ].map(([n, s]) => (
          <button
            key={n}
            className={`thread ${active === n ? 'selected' : ''}`}
            onClick={() => pick(n)}
          >
            {n === 'War room' ? (
              <Avatar name="Director" squad="neutral" />
            ) : inProject ? (
              <Avatar name={n === 'Red squad' ? 'Scout' : 'Patch Engineer'} squad={s as 'red' | 'blue'} />
            ) : (
              <Stacked squad={s as 'red' | 'blue'} />
            )}
            <span>
              <b>{n}</b>
              <small>
                {inProject
                  ? n === 'War room' ? 'Every agent' : n === 'Red squad' ? 'Finds the flaws' : 'Fixes them'
                  : n === 'War room'
                    ? 'All agent activity'
                    : n === 'Red squad'
                      ? 'Offensive operators'
                      : 'Defensive operators'}
              </small>
            </span>
            {n === 'War room' && running && !inProject && <i />}
          </button>
        ))}
        <div className="section">{inProject ? 'AGENTS IN THIS REVIEW' : 'AGENTS'}</div>
        {inProject
          ? projectAgents.map(({ name, squad, count }) => (
              <button key={name} className={`thread agentrow ${active === name ? 'selected' : ''}`} onClick={() => pick(name)}>
                <Avatar name={name} squad={squad} />
                <span>
                  <b>{name}</b>
                  <small>{projectRoles[name] ?? squad}</small>
                </span>
                <em className="count">{count}</em>
              </button>
            ))
          : agents
              .filter((a) => a[0] !== 'Director')
              .map(([n, s]) => (
                <button key={n} className={`thread agentrow ${active === n ? 'selected' : ''}`} onClick={() => pick(n)}>
                  <Avatar name={n} squad={s} />
                  <span>
                    <b>{n}</b>
                    <small>{s === 'red' ? 'Red squad' : 'Blue squad'}</small>
                  </span>
                  <em className={typing === n ? 'online' : ''} />
                </button>
              ))}
        <div className="runs">
          <div className="section">RECENT LAB RUNS</div>
          {runs.length === 0 && <small>No runs yet</small>}
          {runs.slice(0, 5).map((entry) => (
            <button key={entry.id} disabled={busy} onClick={() => {
              setSelectedFinding(null);
              setActive('War room');
              setTab('feed');
              setMobileOpen(false);
              void open(entry.id);
            }}>
              <span className={entry.id === run?.id ? 'runDot live' : 'runDot'} />
              Atlas · {entry.id.slice(0, 6)}<small>{entry.phase}</small>
            </button>
          ))}
        </div>
        <div className="sidefoot">
          <span>
            <Radio size={13} /> Local arena
          </span>
          <span className="healthy">{error ? 'Unavailable' : 'Atlas Commerce'}</span>
        </div>
      </aside>
      <section className="main">
        <header>
          <button className="mobileLogo" onClick={() => setMobileOpen(true)}>
            <Logo compact />
          </button>
          <div>
            <h1>{inProject ? 'Project review' : active}</h1>
            <p>
              {inProject
                ? project?.filename
                : active === 'War room'
                  ? (run?.agentWork ? 'OpenAI agent mode · Practice lab with a synthetic store' : 'Practice lab with a synthetic store')
                  : active.includes('squad')
                    ? 'Squad channel · Practice lab'
                    : `${active} · Agent thread`}
            </p>
          </div>
          <div className="headActions">
            <button className="icon" aria-label="Toggle theme" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {inProject ? (
              <button className="start" disabled={!project?.review} onClick={() => downloadArchive(project!.review!.archive, project!.review!.filename)}>
                <Download size={14} /> Download fixed project
              </button>
            ) : (
              <>
              {running ? (
                <button className="stop" disabled={busy} onClick={() => setRunning(false)}>
                  <CircleStop size={15} /> Pause
                </button>
              ) : (
                <button className="start" disabled={busy || run?.phase === 'approval'} onClick={() => { setTab('feed'); void setRunning(true); }}>
                  <Play size={14} fill="currentColor" /> {run?.phase === 'paused' ? 'Resume' : run?.phase === 'approval' ? 'Awaiting approval' : 'Start run'}
                </button>
              )}
              </>
            )}
          </div>
        </header>
        {error && <p className="arena-error" role="alert">{error}</p>}
        <nav className="tabs">
          {project && (
            <>
              <button className={tab === 'project' ? 'on' : ''} onClick={() => switchTab('project')}>
                <FileCode2 size={14} /> Your project
              </button>
              <em className="tabsLabel">Practice lab</em>
            </>
          )}
          <button className={tab === 'feed' ? 'on' : ''} onClick={() => switchTab('feed')}>
            <Activity size={14} /> Live feed
          </button>
          <button className={tab === 'score' ? 'on' : ''} onClick={() => switchTab('score')}>
            <Sparkles size={14} /> Scoreboard
          </button>
          <button className={tab === 'findings' ? 'on' : ''} onClick={() => switchTab('findings')}>
            <ListFilter size={14} /> Findings <span>{findings.length}</span>
          </button>
        </nav>
        {tab === 'project' && project && <ProjectBattle filter={active} focus={focus} clearFilter={() => setActive('War room')} />}
        {tab === 'feed' && (
          <>
            <div
              className="feed"
              ref={feedRef}
              onScroll={(e) => {
                scrollPositions.current[active] = e.currentTarget.scrollTop;
              }}
            >
              {filtered.length === 0 && (
                <div className="empty">
                  <div className="arena">
                    <Avatar name="Injector" squad="red" />
                    <span>VS</span>
                    <Avatar name="Sentinel" squad="blue" />
                  </div>
                  <h2>{active === 'War room' ? 'Your team is ready' : active}</h2>
                  <p>
                    {running
                      ? 'Messages will appear here as the team checks in.'
                      : 'Start a lab run to test the synthetic target.'}
                  </p>
                  {!running && (
                    <button className="start" disabled={busy || run?.phase === 'approval'} onClick={() => { setTab('feed'); void setRunning(true); }}>
                      <Play size={14} fill="currentColor" /> Start lab run
                    </button>
                  )}
                </div>
              )}
              {filtered.map((m, i) => (
                <div
                  className={`message ${m.squad} ${i > 0 && filtered[i - 1].agent === m.agent ? 'continued' : ''}`}
                  key={m.id}
                >
                  <div className="rail">
                    {(i === 0 || filtered[i - 1].agent !== m.agent) && (
                      <Avatar name={m.agent} squad={m.squad} />
                    )}
                  </div>
                  <div className="bubble">
                    {(i === 0 || filtered[i - 1].agent !== m.agent) && (
                      <div className="meta">
                        <b>{m.agent}</b>
                        <span>{new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {m.source && <span>{m.source}</span>}
                        {m.status && (
                          <label className={m.status}>
                            {m.status === 'blocked'
                              ? 'Blocked'
                              : m.status === 'alert'
                                ? 'Detected'
                                : 'Confirmed'}
                          </label>
                        )}
                      </div>
                    )}
                    <p>{m.text}</p>
                    {m.findingId && (
                      <button className="evidence" onClick={() => {
                        setSelectedFinding(m.findingId!);
                        setTab('findings');
                      }}>
                        <FileCode2 size={16} />
                        <span>View captured evidence</span>
                        <ChevronLeft size={14} />
                      </button>
                    )}
                    {m.approval && run?.phase === 'approval' && (
                      <div className="approval">
                        <div>
                          <AlertTriangle size={18} />
                          <span>
                            <b>Approval required</b>
                            <small>Enforce per-account order ownership</small>
                          </span>
                        </div>
                        <p>
                          Verify the policy against a cross-account request and confirm the account owner can still retrieve the order.
                        </p>
                        <div>
                          <button disabled={busy} onClick={() => choose(false)}>Leave open</button>
                          <button className="danger" disabled={busy} onClick={() => choose(true)}>
                            Approve policy
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {typing && (
                <div className="typing">
                  <Avatar
                    name={typing}
                    squad={
                      (agents.find((a) => a[0] === typing)?.[1] || 'neutral') as Squad
                    }
                  />
                  <span>
                    <b>{typing}</b> is working
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
              <div ref={end} />
            </div>
            <div className="composer">
              <div>
                <Sparkles size={16} />
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send()}
                  placeholder={run ? "Message the Director" : "Start a run to message the Director"}
                  maxLength={2000}
                  disabled={!run || busy}
                />
                <button
                  onClick={send}
                  disabled={!input.trim() || !run || busy}
                  aria-label="Send directive"
                >
                  <ArrowUp size={17} />
                </button>
              </div>
              <small>The Verifier checks tool results. Changes to order access require your approval.</small>
            </div>
          </>
        )}
        {tab === 'score' && <Score stats={stats} phase={run?.phase} />}
        {tab === 'findings' && (
          <Findings findings={findings} run={run} detail={detail} select={setSelectedFinding} />
        )}
      </section>
    </main>
  );
}
function Score({
  stats,
  phase,
}: {
  stats: { attacks: number; caught: number; patched: number; detectMs: number | null; patchMs: number | null; waitingMs: number | null; aiCalls: number };
  phase?: LabRun['phase'];
}) {
  return (
    <div className="panel">
      <div className="panelTitle">
        <div>
          <span className="eyebrow">LIVE EXCHANGE</span>
          <h2>Red vs Blue</h2>
          <p>Measured from target responses and mitigation replays.</p>
        </div>
        <span className={phase === 'running' ? 'liveBadge' : 'liveBadge paused'}>
          <i /> {phase?.toUpperCase() ?? 'READY'}
        </span>
      </div>
      <div className="scoreHero">
        <div className="team red">
          <span>RED SQUAD</span>
          <strong>{stats.caught}</strong>
          <small>confirmed exposures</small>
        </div>
        <div className="versus">VS</div>
        <div className="team blue">
          <span>BLUE SQUAD</span>
          <strong>{stats.patched}</strong>
          <small>verified mitigations</small>
        </div>
      </div>
      <div className="metricGrid">
        <Metric
          icon={<Activity />}
          label="Attack attempts"
          value={String(stats.attacks)}
        />
        <Metric
          icon={<ShieldCheck />}
          label="Patches deployed"
          value={String(stats.patched)}
        />
        <Metric
          icon={<Clock3 />}
          label="Mean detect"
          value={stats.detectMs === null ? '—' : stats.detectMs.toFixed(2) + ' ms'}
        />
        <Metric
          icon={<Clock3 />}
          label="Mean patch"
          value={stats.patchMs === null ? '—' : (stats.patchMs / 1000).toFixed(2) + ' s'}
        />
        <Metric
          icon={<Sparkles />}
          label="AI calls this run"
          value={String(stats.aiCalls)}
        />
        <Metric
          icon={<Clock3 />}
          label="Waiting on you"
          value={stats.waitingMs === null ? '—' : (stats.waitingMs / 1000).toFixed(1) + ' s'}
        />
      </div>
      <div className="coverage">
        <div>
          <b>Surface coverage</b>
          <span>{stats.patched}/3 endpoints hardened</span>
        </div>
        <div className="bar">
          <i style={{ width: `${stats.patched / 3 * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}
function Findings({
  findings, run, detail, select,
}: {
  findings: Finding[];
  run: LabRun | null;
  detail?: Finding;
  select: (id: Finding['id'] | null) => void;
}) {
  const showJev = findings.some((finding) => finding.escalation !== undefined);
  return (
    <div className="panel">
      <div className="panelTitle">
        <div>
          <span className="eyebrow">EVIDENCE LEDGER</span>
          <h2>Confirmed findings</h2>
          <p>Compare the exposure, the attack replay and a legitimate control.</p>
        </div>
        {run?.phase === 'complete' && (
          <a className="liveBadge" href={'/api/arena?id=' + run.id + '&receipt=1'} download>Export evidence</a>
        )}
      </div>
      {!findings.length ? (
        <div className="noFind">
          <ShieldCheck />
          <h3>No confirmed findings yet</h3>
          <p>Start a lab run to populate the evidence ledger.</p>
        </div>
      ) : (
        <div className="table">
          {findings.map((finding) => (
            <div className={'finding' + (showJev ? '' : ' nojev')} key={finding.id}>
              <span className={'sev ' + finding.severity.toLowerCase()}>{finding.severity}</span>
              <div><b>{finding.title}</b><small>Found by {finding.agent}</small></div>
              {showJev && (
                <div>
                  <small>JEV ESCALATION</small>
                  <span>{finding.escalation === undefined ? '—' : Math.round(finding.escalation * 100) + '%'}</span>
                </div>
              )}
              <span className={'state ' + (finding.state === 'Verified' ? 'blocked' : 'open')}>
                {finding.state === 'Verified' && <Check size={12} />}
                {finding.state}
              </span>
              <button onClick={() => select(finding.id === detail?.id ? null : finding.id)}
                aria-expanded={finding.id === detail?.id}>View evidence</button>
            </div>
          ))}
        </div>
      )}
      {detail && (
        <section className="proof" aria-label="Mitigation evidence">
          <h3>{detail.title}</h3>
          {detail.attacks && detail.attacks.length > 0 && (
            <div className="attackLog">
              <b>Red team attempts</b>
              <ol>
                {detail.attacks.map((attack, index) => (
                  <li key={index} className={attack.outcome}>
                    <span className="tag">{attack.kind === 'attempt' ? 'Attempt' : 'Re-attack'}</span>
                    <code>{attack.payload}</code>
                    <small>{attack.source}</small>
                    <em>{attack.outcome === 'leaked' ? 'leaked ' + attack.rows + ' row(s): ' + attack.names.join(', ') : 'blocked · HTTP ' + attack.status}</em>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {detail.verification && detail.verification.length > 1 && (
            <ul>{detail.verification.map((candidate) => (
              <li key={candidate.policy}>{candidate.policy === 'quarantine' ? 'Route quarantine' : 'Scoped fix'} · {candidate.passed ? 'Verified' : 'Rolled back'} · Legitimate request returned {candidate.control.status}</li>
            ))}</ul>
          )}
          <div className="proof-grid">
            <EvidenceCard label="Initial exposure" evidence={detail.before} />
            <EvidenceCard label="Attack replay" evidence={detail.replay} />
            <EvidenceCard label="Legitimate control" evidence={detail.control} />
          </div>
        </section>
      )}
    </div>
  );
}

function EvidenceCard({ label, evidence }: { label: string; evidence?: Evidence }) {
  return (
    <div className="proof-card">
      <b>{label}</b>
      {evidence ? (
        <>
          <small>{evidence.request}</small>
          <small>Status {evidence.status} · {evidence.elapsedMs} ms</small>
          <pre>{JSON.stringify(evidence.response, null, 2)}</pre>
        </>
      ) : <small>Pending policy verification</small>}
    </div>
  );
}
