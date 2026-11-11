export const requirements = {
  checkout: 'Checkout still succeeds',
  assets: 'Public assets stay cacheable',
};
export type Requirement = keyof typeof requirements;
export type CheckStatus = 'Pass' | 'Fail' | 'Inconclusive';
export type TournamentCheck = { id: string; label: string; group: 'security' | Requirement; status: CheckStatus };
export type Candidate = { id: string; label: string; checks: TournamentCheck[]; control?: boolean };
export type Tournament = { id: string; baseline: Candidate; candidates: Candidate[]; image: string };

export function verdict(candidate: Candidate, selected: Requirement[]) {
  const required = candidate.checks.filter(({ group }) => group === 'security' || selected.includes(group));
  if (candidate.control || required.some(({ status }) => status === 'Fail')) return 'Rejected';
  if (!required.length || required.some(({ status }) => status === 'Inconclusive')) return 'Inconclusive';
  return 'Qualifies';
}
