import type { Msg } from './agents';

export type ProbeId = 'sql' | 'ownership' | 'prompt';
export type Evidence = {
  request: string;
  status: number;
  response: unknown;
  elapsedMs: number;
};
export type Finding = {
  id: ProbeId;
  title: string;
  agent: string;
  severity: 'High' | 'Critical';
  openedAt: number;
  state: 'Open' | 'Verified' | 'Rolled back';
  before: Evidence;
  variant?: 'alternate';
  replay?: Evidence;
  control?: Evidence;
  verifiedAt?: number;
  verification?: { policy: 'scoped' | 'quarantine'; passed: boolean; replay: Evidence; control: Evidence }[];
  escalation?: number;
};
export type AgentDecision = { action: string; reason: string; agent: string; time: string };
export type LabRun = {
  agentWork?: { stage: 'red' | 'blue'; decisions: AgentDecision[] };
  id: string;
  createdAt: number;
  phase: 'running' | 'paused' | 'approval' | 'complete' | 'failed';
  step: number;
  nextAt: number;
  approved: boolean | null;
  messages: Msg[];
  findings: Finding[];
  attempts: number;
  detectMs: number[];
};
export type RunSummary = Pick<LabRun, 'id' | 'createdAt' | 'phase'>;
