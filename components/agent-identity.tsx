import type * as React from 'react';
import {
  Crosshair,
  GitMerge,
  KeyRound,
  LockKeyhole,
  MessageSquareWarning,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Wrench,
  Globe,
  Biohazard,
  PackageX,
  GitCommitHorizontal,
} from 'lucide-react';
import { agents, type Squad } from '../lib/agents';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={compact ? 'logo compact' : 'logo'}
      viewBox={compact ? '0 0 27 38' : '0 0 81 38'}
      role="img"
      aria-label="hex"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 6v25m0-11c0-10 16-10 16 0v11" />
        {!compact && (
          <>
            <path d="M32 21h18c0-14-19-14-19 0 0 12 14 13 19 6" />
            <path d="m59 12 15 19m0-19L59 31" />
          </>
        )}
      </g>
    </svg>
  );
}
const glyphs: Record<string, React.ElementType> = {
  Scout: ScanSearch,
  Injector: Crosshair,
  'IDOR Runner': KeyRound,
  'Prompt Smuggler': MessageSquareWarning,
  'SSRF Hunter': Globe,
  'Proto Polluter': Biohazard,
  'Supply Saboteur': PackageX,
  GitHub: GitCommitHorizontal,
  Sentinel: Radar,
  'Patch Engineer': Wrench,
  Triage: GitMerge,
  Containment: LockKeyhole,
  Director: Sparkles,
  Verifier: ShieldCheck,
  You: Sparkles,
};
export function Avatar({
  name,
  squad,
  active = false,
}: {
  name: string;
  squad: Squad;
  active?: boolean;
}) {
  const Glyph = glyphs[name] || Sparkles;
  return (
    <div className={`avatar ${squad} ${active ? 'active' : ''}`}>
      <span className="badge">
        <Glyph strokeWidth={1.9} />
      </span>
    </div>
  );
}
export function Stacked({ squad }: { squad: 'red' | 'blue' }) {
  const list = agents.filter((a) => a[1] === squad).slice(0, 3);
  return (
    <div className="stacked">
      {list.map(([n, s]) => (
        <Avatar key={n} name={n} squad={s} />
      ))}
    </div>
  );
}
