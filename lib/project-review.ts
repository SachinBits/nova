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
};
export type ProjectReport = {
  framework: string;
  scannedFiles: number;
  excludedFiles: number;
  findings: ReviewFinding[];
  checks: string[];
  changes: { file: string; line: number; before: string; after: string }[];
  ai: string;
  tests: { baseline: string; patched: string };
};
