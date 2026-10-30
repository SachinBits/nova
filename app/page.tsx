'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { agents, type Msg, type Squad } from '../lib/agents';
import { Logo, Avatar, Stacked } from '../components/agent-identity';
import { useSimulation } from '../lib/use-simulation';
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronLeft,
  CircleStop,
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

export default function Home() {
  const [dark, setDark] = useState(true);
  const [active, setActive] = useState('War room');
  const [tab, setTab] = useState<'feed' | 'score' | 'findings'>('feed');
  const [input, setInput] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const {
    messages,
    running,
    typing,
    approved,
    stats,
    setRunning,
    reset,
    choose,
    sendDirective,
  } = useSimulation();
  const end = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

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
    if (!directive) return;
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
          onClick={() => {
            reset();
            setActive('War room');
          }}
        >
          <Play size={14} fill="currentColor" /> New simulation
        </button>
        <div className="section">CHANNELS</div>
        {[
          ['War room', 'neutral'],
          ['Red squad', 'red'],
          ['Blue squad', 'blue'],
        ].map(([n, s]) => (
          <button
            key={n}
            className={`thread ${active === n ? 'selected' : ''}`}
            onClick={() => {
              setActive(n);
              setMobileOpen(false);
            }}
          >
            {n === 'War room' ? (
              <Avatar name="Director" squad="neutral" />
            ) : (
              <Stacked squad={s as 'red' | 'blue'} />
            )}
            <span>
              <b>{n}</b>
              <small>
                {n === 'War room'
                  ? 'All agent activity'
                  : n === 'Red squad'
                    ? 'Offensive operators'
                    : 'Defensive operators'}
              </small>
            </span>
            {n === 'War room' && running && <i />}
          </button>
        ))}
        <div className="section">AGENTS</div>
        {agents
          .filter((a) => a[0] !== 'Director')
          .map(([n, s]) => (
            <button
              key={n}
              className={`thread agentrow ${active === n ? 'selected' : ''}`}
              onClick={() => {
                setActive(n);
                setMobileOpen(false);
              }}
            >
              <Avatar name={n} squad={s} />
              <span>
                <b>{n}</b>
                <small>{s === 'red' ? 'Red squad' : 'Blue squad'}</small>
              </span>
              <em className={typing === n ? 'online' : ''} />
            </button>
          ))}
        <div className="runs">
          <div className="section">RECENT RUNS</div>
          <button>
            <span className="runDot live" />
            Live · Atlas Commerce<small>just now</small>
          </button>
          <button>
            <span className="runDot" />
            Run #003 · Meridian<small>Yesterday</small>
          </button>
        </div>
        <div className="sidefoot">
          <span>
            <Radio size={13} /> Local arena
          </span>
          <span className="healthy">Healthy</span>
        </div>
      </aside>
      <section className="main">
        <header>
          <button className="mobileLogo" onClick={() => setMobileOpen(true)}>
            <Logo compact />
          </button>
          <div>
            <h1>{active}</h1>
            <p>
              {active === 'War room'
                ? '9 agents · Live simulation'
                : active.includes('squad')
                  ? 'Squad channel'
                  : `${active} · Agent thread`}
            </p>
          </div>
          <div className="headActions">
            <button className="icon" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {running ? (
              <button className="stop" onClick={() => setRunning(false)}>
                <CircleStop size={15} /> Pause
              </button>
            ) : (
              <button className="start" onClick={() => setRunning(true)}>
                <Play size={14} fill="currentColor" /> Start run
              </button>
            )}
          </div>
        </header>
        <nav className="tabs">
          <button className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>
            <Activity size={14} /> Live feed
          </button>
          <button className={tab === 'score' ? 'on' : ''} onClick={() => setTab('score')}>
            <Sparkles size={14} /> Scoreboard
          </button>
          <button
            className={tab === 'findings' ? 'on' : ''}
            onClick={() => setTab('findings')}
          >
            <ListFilter size={14} /> Findings <span>{stats.attacks}</span>
          </button>
        </nav>
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
                      : 'Start a simulation to bring the conversation to life.'}
                  </p>
                  {!running && (
                    <button className="start" onClick={() => setRunning(true)}>
                      <Play size={14} fill="currentColor" /> Start simulation
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
                        <span>{m.time}</span>
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
                    {m.evidence && (
                      <button className="evidence">
                        <FileCode2 size={16} />
                        <span>
                          {m.evidence}
                          <small>View captured evidence</small>
                        </span>
                        <ChevronLeft size={14} />
                      </button>
                    )}
                    {m.approval && approved === null && (
                      <div className="approval">
                        <div>
                          <AlertTriangle size={18} />
                          <span>
                            <b>Approval required</b>
                            <small>Temporarily disable /api/orders</small>
                          </span>
                        </div>
                        <p>
                          This action affects active sessions. Choose how Containment
                          should proceed.
                        </p>
                        <div>
                          <button onClick={() => choose(false)}>Keep live</button>
                          <button className="danger" onClick={() => choose(true)}>
                            Approve freeze
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
                  placeholder="Message the agents"
                />
                <button
                  onClick={send}
                  disabled={!input.trim()}
                  aria-label="Send directive"
                >
                  <ArrowUp size={17} />
                </button>
              </div>
              <small>Hex may make mistakes. This is a simulated environment.</small>
            </div>
          </>
        )}
        {tab === 'score' && <Score stats={stats} running={running} />}{' '}
        {tab === 'findings' && <Findings messages={messages} />}
      </section>
    </main>
  );
}
function Score({
  stats,
  running,
}: {
  stats: { attacks: number; caught: number; patched: number };
  running: boolean;
}) {
  return (
    <div className="panel">
      <div className="panelTitle">
        <div>
          <span className="eyebrow">LIVE EXCHANGE</span>
          <h2>Red vs Blue</h2>
          <p>Every number follows the simulated agent timeline.</p>
        </div>
        <span className={running ? 'liveBadge' : 'liveBadge paused'}>
          <i /> {running ? 'RUNNING' : 'PAUSED'}
        </span>
      </div>
      <div className="scoreHero">
        <div className="team red">
          <span>RED SQUAD</span>
          <strong>{Math.max(0, stats.attacks - stats.caught)}</strong>
          <small>successful breaches</small>
        </div>
        <div className="versus">VS</div>
        <div className="team blue">
          <span>BLUE SQUAD</span>
          <strong>{stats.caught}</strong>
          <small>incidents caught</small>
        </div>
      </div>
      <div className="metricGrid">
        <Metric
          icon={<Activity />}
          label="Attacks attempted"
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
          value={stats.caught ? '2.1s' : '—'}
        />
        <Metric
          icon={<Clock3 />}
          label="Mean patch"
          value={stats.patched ? '7.4s' : '—'}
        />
      </div>
      <div className="coverage">
        <div>
          <b>Surface coverage</b>
          <span>{stats.patched}/4 endpoints hardened</span>
        </div>
        <div className="bar">
          <i style={{ width: `${stats.patched * 25}%` }} />
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
function Findings({ messages }: { messages: Msg[] }) {
  const items = [
    messages.some((m) => m.agent === 'Injector' && m.status === 'success') && [
      'Critical',
      'Unbounded customer lookup',
      'Injector',
      'Patch Engineer',
      'Blocked',
    ],
    messages.some((m) => m.agent === 'IDOR Runner') && [
      'High',
      'Cross-account order access',
      'IDOR Runner',
      'Unassigned',
      'Open',
    ],
  ].filter(Boolean) as string[][];
  return (
    <div className="panel">
      <div className="panelTitle">
        <div>
          <span className="eyebrow">EVIDENCE LEDGER</span>
          <h2>Confirmed findings</h2>
          <p>Incidents appear here as the simulation unfolds.</p>
        </div>
      </div>
      {!items.length ? (
        <div className="noFind">
          <ShieldCheck />
          <h3>No confirmed findings yet</h3>
          <p>Start the simulation to populate the evidence ledger.</p>
        </div>
      ) : (
        <div className="table">
          {items.map((a, i) => (
            <div className="finding" key={i}>
              <span className={`sev ${a[0].toLowerCase()}`}>{a[0]}</span>
              <div>
                <b>{a[1]}</b>
                <small>Found by {a[2]}</small>
              </div>
              <div>
                <small>OWNER</small>
                <span>{a[3]}</span>
              </div>
              <span className={`state ${a[4].toLowerCase()}`}>
                {a[4] === 'Blocked' ? <Check size={12} /> : null}
                {a[4]}
              </span>
              <button>View evidence</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
