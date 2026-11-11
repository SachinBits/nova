export const uploadLimit = 12 * 1024 * 1024;
export type ProjectUpdate = { squad: 'red' | 'blue' | 'neutral'; agent: string; text: string };
export type ProjectReviewResult = { report: ProjectReport; archive: string };
export type ProjectReviewEvent =
  | { type: 'update'; update: ProjectUpdate }
  | { type: 'complete'; result: ProjectReviewResult }
  | { type: 'error'; message: string };

export type ReviewFinding = {
  file: string;
  line: number;
  title: string;
  detail: string;
  status: 'Patched' | 'Review';
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  cwe: string;
  verification?: 'test-verified' | 'syntax-checked in Docker (no tests)' | 'syntax-checked in Docker (no passing tests)' | 'proven by generated exploit test';
};
export type TestResult = { syntaxOk: boolean; jsChecked: number; pass: number; fail: number; summary: string };
export const testCounts = ({ pass, fail }: TestResult) => pass + ' passed, ' + fail + ' failed';
export type ProjectReport = {
  framework: string;
  scannedFiles: number;
  excludedFiles: number;
  findings: ReviewFinding[];
  checks: string[];
  changes: { file: string; line: number; before: string; after: string }[];
  ai: string;
  tests: { baseline: TestResult; patched: TestResult };
  kept: 'Deterministic + AI' | 'AI only' | 'Deterministic only' | 'None';
  tsChecked: number;
  aiCalls?: number;
  source?: { repo: string; ref?: string; commit?: string };
};
