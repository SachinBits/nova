'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FileSearch, FlaskConical, ScanSearch, ShieldCheck, Wrench, X } from 'lucide-react';
import type { ProjectUpdate } from '../lib/project-review';
import { Avatar } from './agent-identity';
import { ProjectReviewResults } from './project-review-results';
import { useProjectReview } from './project-review-session';

const steps = [
  { label: 'Read the code', hint: 'Unpack the ZIP and parse each file', icon: FileSearch },
  { label: 'Find weaknesses', hint: 'Red team hunts for security flaws', icon: ScanSearch },
  { label: 'Test the original', hint: 'Run its tests in a sealed sandbox', icon: FlaskConical },
  { label: 'Write fixes', hint: 'Blue team edits the risky lines', icon: Wrench },
  { label: 'Prove the fixes', hint: 'Re-run the tests on the fixed copy', icon: ShieldCheck },
];

export const projectRoles: Record<string, string> = {
  Director: 'Coordinator',
  Scout: 'Red team · finds flaws',
  'Patch Engineer': 'Blue team · writes fixes',
  Verifier: 'Referee · runs the tests',
};

function stageOf({ agent, text }: ProjectUpdate) {
  if (agent === 'Scout') return 1;
  if (agent === 'Patch Engineer') return 3;
  if (agent === 'Verifier') return /patched copy/i.test(text) ? 4 : 2;
  return 0;
}

export function matchesFilter(update: ProjectUpdate, filter: string) {
  if (filter === 'War room') return true;
  if (filter === 'Red squad') return update.squad === 'red' || update.squad === 'neutral';
  if (filter === 'Blue squad') return update.squad === 'blue' || update.squad === 'neutral';
  return update.agent === filter;
}

export function ProjectBattle({ filter, focus, clearFilter }: { filter: string; focus: number; clearFilter: () => void }) {
  const { project } = useProjectReview();
  const panel = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [logChoice, setLogChoice] = useState<boolean | null>(null);
  const done = !!project?.review;
  const wasDone = useRef(done);
  const seenFocus = useRef(focus);
  const filtered = project?.updates.filter((update) => matchesFilter(update, filter)) ?? [];
  const logOpen = logChoice ?? (!done || filter !== 'War room');

  useEffect(() => {
    if (!done && follow.current && panel.current) panel.current.scrollTop = panel.current.scrollHeight;
  }, [project?.updates.length, done]);

  // Only a live transition scrolls, so returning to a finished review leaves the reader at the top.
  useEffect(() => {
    if (done === wasDone.current) return;
    wasDone.current = done;
    if (!done) return;
    setLogChoice(null);
    requestAnimationFrame(() => results.current?.scrollIntoView({ block: 'start' }));
  }, [done]);

  // Counts sidebar clicks, so War room and repeat clicks on the same agent also open the log.
  useEffect(() => {
    if (focus === seenFocus.current) return;
    seenFocus.current = focus;
    setLogChoice(true);
    requestAnimationFrame(() => log.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [focus]);

  if (!project) return null;
  const reached = Math.max(0, ...project.updates.map(stageOf));
  const status = done ? 'Complete' : project.error ? 'Stopped' : 'Running';

  return (
    <section className="panel pr" aria-label="Project review" ref={panel} onScroll={(event) => {
      const node = event.currentTarget;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    }}>
      <div className="pr-head">
        <div>
          <span className="eyebrow">PROJECT REVIEW</span>
          <h2>{project.filename}</h2>
          <p>A broad security review. JavaScript, TypeScript and Python are fixed and verified in a locked-down Docker sandbox; other languages are flagged. Red agents look for security flaws, Blue agents fix what they safely can, and a referee proves each fix.</p>
        </div>
        <span className={'pr-status ' + status.toLowerCase()}>{!done && !project.error && <i />}{status}</span>
      </div>

      <ol className="pr-steps" aria-label="Review progress">
        {steps.map(({ label, hint, icon: Icon }, index) => {
          const state = done || index < reached ? 'done' : index === reached ? (project.error ? 'failed' : 'active') : 'todo';
          return (
            <li key={label} className={state}>
              <span className="pr-stepIcon">{state === 'done' ? <Check size={14} /> : state === 'failed' ? <X size={14} /> : <Icon size={14} />}</span>
              <b>{index + 1}. {label}</b>
              <small>{hint}</small>
            </li>
          );
        })}
      </ol>

      {project.error && <div className="pr-error" role="alert"><b>The review stopped.</b> {project.error}</div>}
      {project.review && <div ref={results} style={{ scrollMarginTop: 16 }}><ProjectReviewResults review={project.review} updates={project.updates} /></div>}

      <div className="pr-log" ref={log}>
        <button className="pr-logToggle" aria-expanded={logOpen} onClick={() => setLogChoice(!logOpen)}>
          <ChevronDown size={15} className={logOpen ? 'open' : ''} />
          <b>Agent conversation</b>
          <span>{filtered.length} message{filtered.length === 1 ? '' : 's'}</span>
        </button>
        {filter !== 'War room' && (
          <span className="pr-filter">Showing {filter}<button aria-label="Show all agents" onClick={clearFilter}><X size={12} /></button></span>
        )}
        {logOpen && (
          <div role="log" aria-label="Agent activity">
            {filtered.length === 0 && <p className="pr-empty">No messages from {filter} in this review. Scout, Patch Engineer, Verifier and Director take part in project reviews.</p>}
            {filtered.map((update, index) => (
              <div className={`message ${update.squad}`} key={index}>
                <div className="rail"><Avatar name={update.agent} squad={update.squad} /></div>
                <div className="bubble">
                  <div className="meta"><b>{update.agent}</b><span>{projectRoles[update.agent] ?? update.squad}</span></div>
                  <p>{update.text}</p>
                </div>
              </div>
            ))}
            {!done && !project.error && <p className="pr-working" role="status"><i /><i /><i /> Agents are working…</p>}
          </div>
        )}
      </div>
    </section>
  );
}
