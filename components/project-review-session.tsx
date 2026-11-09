'use client';

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import type { ProjectReviewEvent, ProjectReviewResult, ProjectUpdate } from '../lib/project-review';

export type ReviewResult = ProjectReviewResult & { filename: string };
type ProjectRun = {
  filename: string;
  updates: ProjectUpdate[];
  review?: ReviewResult;
  error?: string;
};
const ReviewContext = createContext<{
  project: ProjectRun | null;
  startReview: (file: File, useAI: boolean) => void;
} | null>(null);

async function receiveReview(file: File, useAI: boolean, emit: (event: ProjectReviewEvent) => void) {
  const response = await fetch('/api/project-review?stream=1' + (useAI ? '&ai=1' : ''), {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || 'The project review failed.');
  }
  if (!response.body) throw new Error('The project review did not return a live stream.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (pending + value).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as ProjectReviewEvent;
        if (event.type === 'error') throw new Error(event.message);
        emit(event);
        if (event.type === 'complete') return;
      }
    }
    throw new Error('The review connection closed before the report was ready.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function ProjectReviewSession({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<ProjectRun | null>(null);
  const running = useRef(false);

  function startReview(file: File, useAI: boolean) {
    if (running.current) return;
    running.current = true;
    setProject({ filename: file.name, updates: [] });
    void receiveReview(file, useAI, (event) => {
      setProject((current) => {
        if (!current) return current;
        if (event.type === 'update') return { ...current, updates: [...current.updates, event.update] };
        if (event.type === 'complete') return { ...current, review: { filename: file.name, ...event.result } };
        return current;
      });
    }).catch((failure: unknown) => {
      setProject((current) => current && {
        ...current, error: failure instanceof Error ? failure.message : 'The project review failed.',
      });
    }).finally(() => { running.current = false; });
  }

  return <ReviewContext.Provider value={{ project, startReview }}>{children}</ReviewContext.Provider>;
}

export function useProjectReview() {
  const context = useContext(ReviewContext);
  if (!context) throw new Error('ProjectReviewSession is missing');
  return context;
}
