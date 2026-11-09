'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Logo } from '../components/agent-identity';
import { useProjectReview } from '../components/project-review-session';
import { uploadLimit } from '../lib/project-review';

export default function ProjectReview() {
  const router = useRouter();
  const { project, startReview } = useProjectReview();
  const [file, setFile] = useState<File>();
  const [useAI, setUseAI] = useState(false);
  const busy = !!project && !project.review && !project.error;
  const [error, setError] = useState('');

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setError('');
    if (file.size > uploadLimit) {
      setError('Choose a ZIP up to 12 MB.');
      return;
    }
    startReview(file, useAI);
    router.push('/war-room');
  }

  return (
    <main className="shell review-shell">
      <header>
        <Logo />
        <div className="headActions"><Link className="start" href="/war-room">
          {project ? 'Return to war room' : 'Open demo war room'}
        </Link></div>
      </header>
      <section className="review-content" aria-labelledby="review-heading">
        <h1 id="review-heading">Review a project</h1>
        <p>Upload a JavaScript or TypeScript project ZIP. Follow Red and Blue in the War Room while Hex reviews your project.</p>
        <form onSubmit={review} aria-busy={busy}>
          <fieldset disabled={busy}>
            <label htmlFor="project-zip">Project ZIP</label>
            <input id="project-zip" type="file" accept=".zip,application/zip" required
              aria-describedby="project-zip-help" onChange={(event) => {
                setFile(event.target.files?.[0]);
                setError('');
              }} />
            <p id="project-zip-help">Up to 12 MB. Common credential files and generated dependencies are excluded.</p>
            <label className="review-opt-in">
              <input type="checkbox" checked={useAI} onChange={(event) => setUseAI(event.target.checked)} />
              Send selected source files to OpenAI for advisory review
            </label>
            <button className="start" disabled={!file || busy}>{busy ? 'Reviewing project…' : 'Review project'}</button>
          </fieldset>
        </form>
        {busy && <p role="status">Your review is running in the War Room.</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
