import type { Msg } from './agents';

export type ProbeId = 'sql' | 'ownership' | 'prompt' | 'ssrf' | 'pollution' | 'supply';
export type Evidence = {
  request: string;
  status: number;
  response: unknown;
  elapsedMs: number;
};
export type Attack = {
  kind: 'attempt' | 'reattack';
  payload: string;
  rationale: string;
  source: 'OpenAI' | 'Groq' | 'Local';
  status: number;
  rows: number;
  names: string[];
  outcome: 'leaked' | 'blocked';
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
  payload?: string;
  attacks?: Attack[];
  replay?: Evidence;
  control?: Evidence;
  verifiedAt?: number;
  verification?: { policy: 'scoped' | 'quarantine'; passed: boolean; replay: Evidence; control: Evidence }[];
  escalation?: number;
};
export type AgentDecision = { action: string; reason: string; agent: string; time: string };
export type LabRun = {
  agentWork?: { provider?: 'OpenAI' | 'Groq'; stage: 'red' | 'blue'; decisions: AgentDecision[]; craft?: 'attempt' | 'reattack' };
  sqlAttempts?: Attack[];
  aiCalls?: number;
  approvalRequestedAt?: number;
  approvalAnsweredAt?: number;
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
