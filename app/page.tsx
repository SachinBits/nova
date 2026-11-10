'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ScanSearch, Wrench, ShieldCheck, Swords, FileCode2, Play } from 'lucide-react';
import { Logo } from '../components/agent-identity';
import { useProjectReview } from '../components/project-review-session';
import { uploadLimit } from '../lib/project-review';

const steps = [
  { icon: ScanSearch, label: 'Find', hint: 'Red agents probe your code for real security flaws.' },
  { icon: Wrench, label: 'Fix', hint: 'Blue agents rewrite only what they can change safely.' },
  { icon: ShieldCheck, label: 'Prove', hint: 'A referee re-runs your tests in a locked-down sandbox.' },
];

export default function Landing() {
  const router = useRouter();
  const { project, startReview } = useProjectReview();
  const [file, setFile] = useState<File>();
  const [useAI, setUseAI] = useState(false);
  const busy = !!project && !project.review && !project.error;
  const [error, setError] = useState('');
  const [loadingSample, setLoadingSample] = useState(false);

  function begin(chosen: File) {
    if (chosen.size > uploadLimit) {
      setError('Choose a ZIP up to 12 MB.');
      return;
    }
    startReview(chosen, useAI);
    router.push('/war-room');
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setError('');
    begin(file);
  }

  async function trySample() {
    if (busy || loadingSample) return;
    setError('');
    setLoadingSample(true);
    try {
      const response = await fetch('/hex-sample-store.zip');
      if (!response.ok) throw new Error('fetch failed');
      const blob = await response.blob();
      begin(new File([blob], 'hex-sample-store.zip', { type: 'application/zip' }));
    } catch {
      setError('The sample project could not be loaded. Run npm run sample, then retry.');
      setLoadingSample(false);
    }
  }

  return (
    <main className="shell landing">
      <header>
        <Logo />
        <div className="headActions">
          <Link className="ghost" href="/war-room">Open the war room</Link>
        </div>
      </header>
      <section className="landing-body">
        <div className="landing-hero">
          <span className="eyebrow">AI RED TEAM VS BLUE TEAM</span>
          <h1>Hex: AI red team vs blue team</h1>
          <p>Finds security flaws in your code, fixes what it safely can, and proves each fix in a locked-down sandbox.</p>
        </div>

        <ol className="landing-steps" aria-label="How Hex works">
          {steps.map(({ icon: Icon, label, hint }) => (
            <li key={label}>
              <span className="landing-stepIcon"><Icon size={18} /></span>
              <b>{label}</b>
              <small>{hint}</small>
            </li>
          ))}
        </ol>

        <div className="landing-cards">
          <section className="landing-card" aria-labelledby="review-heading">
            <div className="landing-cardIcon red"><FileCode2 size={18} /></div>
            <h2 id="review-heading">Review your project</h2>
            <p>Upload a project ZIP for a broad security review, and follow Red and Blue as they work. JavaScript, TypeScript and Python are fixed and verified; other languages are flagged.</p>
            <form onSubmit={review} aria-busy={busy}>
              <fieldset disabled={busy}>
                <label htmlFor="project-zip">Project ZIP</label>
                <input id="project-zip" type="file" accept=".zip,application/zip"
                  aria-describedby="project-zip-help" onChange={(event) => {
                    setFile(event.target.files?.[0]);
                    setError('');
                  }} />
                <p id="project-zip-help">Up to 12 MB. Credential files and dependencies are excluded.</p>
                <label className="review-opt-in">
                  <input type="checkbox" checked={useAI} onChange={(event) => setUseAI(event.target.checked)} />
                  Send selected source files to OpenAI for advisory review
                </label>
                <div className="landing-actions">
                  <button className="start" disabled={!file || busy}>{busy ? 'Reviewing…' : 'Review project'}</button>
                  <button type="button" className="ghost" disabled={busy || loadingSample} onClick={trySample}>
                    {loadingSample ? 'Loading sample…' : 'Try the sample project'}
                  </button>
                </div>
              </fieldset>
            </form>
            {busy && <p role="status">Your review is running in the war room.</p>}
            {error && <p className="landing-error" role="alert">{error}</p>}
          </section>

          <section className="landing-card" aria-labelledby="lab-heading">
            <div className="landing-cardIcon blue"><Swords size={18} /></div>
            <h2 id="lab-heading">Watch a live attack lab</h2>
            <p>No upload needed. Watch Red craft attacks and Blue verify fixes against a synthetic store, with you in control of the risky change.</p>
            <div className="landing-actions">
              <button className="start" onClick={() => router.push('/war-room?start=1')}>
                <Play size={14} fill="currentColor" /> Start a lab run
              </button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
