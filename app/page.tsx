'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ScanSearch, Wrench, ShieldCheck, Swords, FileCode2, Play, GitBranch, Radio } from 'lucide-react';
import { Logo } from '../components/agent-identity';
import { useProjectReview } from '../components/project-review-session';
import { requirements, type Requirement } from '../lib/tournament';
import { uploadLimit } from '../lib/project-review';

const steps = [
  { icon: ScanSearch, label: 'Find', hint: 'Red reviews your code for security issues.' },
  { icon: Wrench, label: 'Fix', hint: 'Blue agents rewrite only what they can change safely.' },
  { icon: ShieldCheck, label: 'Prove', hint: 'A referee re-runs your tests in a locked-down sandbox.' },
];

export default function Landing() {
  const router = useRouter();
  const { project, startReview } = useProjectReview();
  const [file, setFile] = useState<File>();
  const [repo, setRepo] = useState('');
  const [useAI, setUseAI] = useState(false);
  const [selected, setSelected] = useState<Requirement[]>(['checkout', 'assets']);
  const busy = !!project && !project.review && !project.error;
  const [error, setError] = useState('');
  const [loadingSample, setLoadingSample] = useState(false);

  function begin(chosen: File) {
    if (chosen.size > uploadLimit) {
      setError('Choose a ZIP up to 12 MB.');
      return;
    }
    startReview({ file: chosen }, useAI, selected);
    router.push('/war-room');
  }

  function reviewRepo() {
    const link = repo.trim();
    if (!link || busy) return;
    if (!/^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+|^[\w.-]+\/[\w.-]+$/i.test(link)) {
      setError('Enter a GitHub repository link such as https://github.com/owner/repo.');
      return;
    }
    setError('');
    startReview({ repo: link }, useAI, selected);
    router.push('/war-room');
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setError('');
    begin(file);
  }

  async function trySample(filename: string) {
    if (busy || loadingSample) return;
    setError('');
    setLoadingSample(true);
    try {
      const response = await fetch('/' + filename);
      if (!response.ok) throw new Error('fetch failed');
      const blob = await response.blob();
      begin(new File([blob], filename, { type: 'application/zip' }));
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
          <Link className="ghost" href="/live">Live monitor</Link>
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
            <p>Upload a project ZIP or paste a GitHub link for a broad security review, and follow Red and Blue as they work. JavaScript, TypeScript and Python are fixed and verified; other languages are flagged.</p>
            <form onSubmit={review} aria-busy={busy}>
              <fieldset disabled={busy}>
                <label htmlFor="project-zip">Project ZIP</label>
                <input id="project-zip" type="file" accept=".zip,application/zip"
                  aria-describedby="project-zip-help" onChange={(event) => {
                    setFile(event.target.files?.[0]);
                    setError('');
                  }} />
                <p id="project-zip-help">Up to 12 MB. Credential files and dependencies are excluded.</p>
                <label htmlFor="project-repo">Or a GitHub repository</label>
                <div className="landing-repo">
                  <input id="project-repo" type="text" inputMode="url" spellCheck={false} autoComplete="off"
                    placeholder="https://github.com/owner/repo" value={repo} aria-describedby="project-repo-help"
                    onChange={(event) => { setRepo(event.target.value); setError(''); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); reviewRepo(); } }} />
                  <button type="button" className="ghost" disabled={!repo.trim() || busy} onClick={reviewRepo}>
                    <GitBranch size={14} /> Review repo
                  </button>
                </div>
                <p id="project-repo-help">Public repositories, or private ones with GITHUB_TOKEN set. Add /tree/branch to pick a branch.</p>
                <label className="review-opt-in">
                  <input type="checkbox" checked={useAI} onChange={(event) => setUseAI(event.target.checked)} />
                  Send selected source files to the configured AI provider (OpenAI or Groq) for advisory review
                </label>
                <fieldset>
                  <legend>Field Supply requirements</legend>
                  {(Object.keys(requirements) as Requirement[]).map((key) => (
                    <label className="review-opt-in" key={key}><input type="checkbox" checked={selected.includes(key)} onChange={(event) => {
                      setSelected(event.target.checked ? [...selected, key] : selected.filter((item) => item !== key));
                    }} /> {requirements[key]}</label>
                  ))}
                </fieldset>
                <div className="landing-actions">
                  <button className="start" disabled={!file || busy}>{busy ? 'Reviewing…' : 'Review project'}</button>
                  <button type="button" className="ghost" disabled={busy || loadingSample} onClick={() => void trySample('hex-sample-store.zip')}>
                    {loadingSample ? 'Loading sample…' : 'Try the sample project'}
                  </button>
                  <button type="button" className="ghost" disabled={busy || loadingSample} onClick={() => void trySample('field-supply-tournament.zip')}>Try Field Supply tournament</button>
                </div>
              </fieldset>
            </form>
            {busy && <p role="status">Your review is running in the war room.</p>}
            {error && <p className="landing-error" role="alert">{error}</p>}
          </section>

          <section className="landing-card" aria-labelledby="lab-heading">
            <div className="landing-cardIcon blue"><Swords size={18} /></div>
            <h2 id="lab-heading">Watch a live attack lab</h2>
            <p>No upload needed. Watch Red run SQL injection, IDOR, prompt injection, SSRF, prototype pollution and a hijacked npm release against a synthetic store, while Blue verifies each fix. You stay in control of the risky change.</p>
            <div className="landing-actions">
              <button className="start" onClick={() => router.push('/war-room?start=1')}>
                <Play size={14} fill="currentColor" /> Start a lab run
              </button>
            </div>
          </section>

          <section className="landing-card" aria-labelledby="live-heading">
            <div className="landing-cardIcon blue"><Radio size={18} /></div>
            <h2 id="live-heading">Review every push</h2>
            <p>Hex watches your GitHub repositories, reviews each new commit, flags what that push introduced or fixed, and posts a pass or fail status on the commit.</p>
            <div className="landing-actions">
              <Link className="start" href="/live"><Radio size={14} /> Open the live monitor</Link>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
