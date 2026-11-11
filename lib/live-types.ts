import type { ProjectReport, ProjectUpdate, ReviewFinding } from './project-review';

export type LiveStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';
export type LiveFinding = Pick<ReviewFinding, 'file' | 'line' | 'title' | 'severity' | 'status'>;
export type LivePush = {
  id: string;
  repo: string;
  branch: string;
  sha: string;
  message: string;
  author: string;
  compare?: string;
  trigger: 'webhook' | 'poll' | 'manual';
  receivedAt: number;
  startedAt?: number;
  finishedAt?: number;
  status: LiveStatus;
  updates: ProjectUpdate[];
  report?: ProjectReport;
  error?: string;
  githubStatus?: string;
  githubComment?: string;
  summary?: {
    total: number;
    counts: Record<ReviewFinding['severity'], number>;
    baseline: boolean;
    previousSha?: string;
    introduced: LiveFinding[];
    fixed: LiveFinding[];
    blocking: number;
    ai?: string;
  };
};
export type LivePushSummary = Omit<LivePush, 'report'> & { hasReport: boolean };
export type LiveConfig = {
  watching: string[];
  pollSeconds: number;
  lastPoll?: number;
  pollError?: string;
  webhook: boolean;
  token: boolean;
  ai?: string;
  publicUrl: string;
};
