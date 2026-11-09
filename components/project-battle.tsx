'use client';

import { useEffect, useRef } from 'react';
import { Avatar } from './agent-identity';
import { ProjectReviewResults } from './project-review-results';
import { useProjectReview } from './project-review-session';

export function ProjectBattle() {
  const { project } = useProjectReview();
  const panel = useRef<HTMLElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    if (follow.current && panel.current) panel.current.scrollTop = panel.current.scrollHeight;
  }, [project?.updates.length]);

  if (!project) return null;

  return (
    <section className="panel" aria-label="Project battle" ref={panel} onScroll={(event) => {
      const node = event.currentTarget;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    }}>
      <div className="panelTitle">
        <div><h2>{project.filename}</h2><p>Live project review</p></div>
        <span className="liveBadge">{project.review ? 'COMPLETE' : project.error ? 'FAILED' : 'RUNNING'}</span>
      </div>
      <div role="log" aria-label="Red and Blue activity">
        {project.updates.map((update, index) => (
          <div className={`message ${update.squad}`} key={index}>
            <div className="rail"><Avatar name={update.agent} squad={update.squad} /></div>
            <div className="bubble">
              <div className="meta"><b>{update.agent}</b><span>{update.squad === 'red' ? 'Red team' : update.squad === 'blue' ? 'Blue team' : 'Verification'}</span></div>
              <p>{update.text}</p>
            </div>
          </div>
        ))}
      </div>
      {project.error && <p role="alert">{project.error}</p>}
      {!project.review && !project.error && <p role="status">Review in progress…</p>}
      {project.review && <ProjectReviewResults review={project.review} />}
    </section>
  );
}
