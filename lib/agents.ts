export type Squad = 'red' | 'blue' | 'neutral' | 'you';
export type Msg = {
  id: number;
  agent: string;
  squad: Squad;
  text: string;
  time: string;
  evidence?: string;
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
export const timeline: Omit<Msg, 'id' | 'time'>[] = [
  {
    agent: 'Director',
    squad: 'neutral',
    text: 'Arena online. Red squad is mapping the target while Blue establishes a traffic baseline.',
  },
  {
    agent: 'Scout',
    squad: 'red',
    text: 'Surface mapped. Four routes stand out; the customer lookup is accepting raw query input.',
    evidence: 'surface-map.json · 4 routes',
  },
  {
    agent: 'Injector',
    squad: 'red',
    text: 'Testing the lookup boundary with a crafted query. The response widened from 1 record to 8.',
    evidence: 'capture_001.http · 200 OK',
    status: 'success',
  },
  {
    agent: 'Sentinel',
    squad: 'blue',
    text: 'Anomalous query shape detected. Confidence 96%. Looping in Triage and Patch Engineer.',
    status: 'alert',
  },
  {
    agent: 'Triage',
    squad: 'blue',
    text: 'Incident HX-104 opened · Customer lookup · Injection pattern. Duplicate signals merged.',
  },
  {
    agent: 'Patch Engineer',
    squad: 'blue',
    text: 'Guard prepared and promoted to the edge policy. Replaying the exact request now.',
    evidence: 'policy-diff.hex · +12 lines',
  },
  {
    agent: 'Injector',
    squad: 'red',
    text: 'Retry returned 403. Same request, same payload — boundary is holding.',
    evidence: 'capture_002.http · 403 Blocked',
    status: 'blocked',
  },
  {
    agent: 'Director',
    squad: 'neutral',
    text: 'Blue caught and contained the first exchange in 7.4s. Score: Blue +1.',
    status: 'success',
  },
  {
    agent: 'IDOR Runner',
    squad: 'red',
    text: 'Walking adjacent order references. Two records crossed the expected account boundary.',
    evidence: 'orders-sample.json · 2 records',
    status: 'success',
  },
  {
    agent: 'Sentinel',
    squad: 'blue',
    text: 'Sequential object access escalated. Rate is 6.2× the account baseline.',
    status: 'alert',
  },
  {
    agent: 'Containment',
    squad: 'blue',
    text: 'I can freeze the orders route while the ownership rule is applied. This interrupts active sessions and needs approval.',
    approval: true,
  },
];
