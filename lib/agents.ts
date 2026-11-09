export type Squad = 'red' | 'blue' | 'neutral' | 'you';
export type Msg = {
  id: number;
  agent: string;
  squad: Squad;
  text: string;
  time: string;
  findingId?: 'sql' | 'ownership' | 'prompt';
  source?: 'OpenAI' | 'Local';
  status?: 'blocked' | 'success' | 'alert';
  approval?: boolean;
};
export const agents = [
  ['Scout', 'red'],
  ['Injector', 'red'],
  ['IDOR Runner', 'red'],
  ['Prompt Smuggler', 'red'],
  ['Sentinel', 'blue'],
  ['Patch Engineer', 'blue'],
  ['Triage', 'blue'],
  ['Containment', 'blue'],
  ['Director', 'neutral'],
] as const;
