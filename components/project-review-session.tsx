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
// A review starts from an uploaded ZIP or from a public GitHub repository link.
export type ReviewInput = { file: File } | { repo: string };
const ReviewContext = createContext<{
  project: ProjectRun | null;
  startReview: (input: ReviewInput, useAI: boolean) => void;
} | null>(null);

// A readable, filesystem-safe name for a repository link, used for the header and downloads.
function repoName(link: string) {
  const path = link.trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/(tree|commit)\//, '@');
  return path.replace(/[^\w.@-]+/g, '-').replace(/^-+|-+$/g, '') || 'github-repo';
}

async function receiveReview(input: ReviewInput, useAI: boolean, emit: (event: ProjectReviewEvent) => void) {
  const response = await fetch('/api/project-review?stream=1' + (useAI ? '&ai=1' : ''), 'file' in input
    ? { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: input.file }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: input.repo }) });
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

  function startReview(input: ReviewInput, useAI: boolean) {
    if (running.current) return;
    running.current = true;
    const filename = 'file' in input ? input.file.name : repoName(input.repo);
    setProject({ filename, updates: [] });
    void receiveReview(input, useAI, (event) => {
      setProject((current) => {
        if (!current) return current;
        if (event.type === 'update') return { ...current, updates: [...current.updates, event.update] };
        if (event.type === 'complete') return { ...current, review: { filename, ...event.result } };
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
