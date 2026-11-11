'use client';

import { useState } from 'react';
import { requirements, verdict, type Requirement, type Tournament } from '../lib/tournament';

export function TournamentResults({ evidence, filename, initial }: { evidence: Tournament; filename: string; initial?: Requirement[] }) {
  const [selected, setSelected] = useState<Requirement[]>(initial ?? ['checkout', 'assets']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rows = [evidence.baseline, ...evidence.candidates];
  async function download(candidate: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/project-review/tournament', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: evidence.id, candidate, requirements: selected }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Download failed.');
      const bytes = Uint8Array.from(atob(result.archive), (part) => part.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename.replace(/\.zip$/i, '') + '-' + candidate + '.zip';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Download failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pr-results" aria-label="Patch tournament">
      <h2>Patch tournament</h2>
      <fieldset disabled={busy}>
        <legend>What must still work?</legend>
        {(Object.keys(requirements) as Requirement[]).map((key) => (
          <p key={key}><label><input type="checkbox" checked={selected.includes(key)} onChange={(event) => {
            setSelected(event.target.checked ? [...selected, key] : selected.filter((item) => item !== key));
          }} /> {requirements[key]}</label></p>
        ))}
      </fieldset>
      <p>Security assertions are required. Changing a requirement recalculates the verdict from the recorded Docker checks.</p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th scope="col">Check</th>{rows.map(({ id, label }) => <th scope="col" key={id}>{label}</th>)}</tr></thead>
          <tbody>
            {evidence.baseline.checks.map(({ id, label, group }) => (
              <tr key={id}>
                <th scope="row">{label}{group === 'security' || selected.includes(group) ? ' (required)' : ''}</th>
                {rows.map((row) => <td key={row.id}>{row.checks.find((check) => check.id === id)?.status ?? 'Inconclusive'}</td>)}
              </tr>
            ))}
            <tr><th scope="row">Verdict</th><td>Baseline</td>{evidence.candidates.map((item) => <td key={item.id}>{verdict(item, selected)}</td>)}</tr>
            <tr><th scope="row">Export</th><td>—</td>{evidence.candidates.map((item) => (
              <td key={item.id}>{verdict(item, selected) === 'Qualifies' && (
                <button className="start" disabled={busy} onClick={() => void download(item.id)}>Download ZIP</button>
              )}</td>
            ))}</tr>
          </tbody>
        </table>
      </div>
      {error && <p role="alert">{error}</p>}
      {rows.some((row) => row.checks.some(({ status }) => status === 'Inconclusive')) && (
        <p><a href="/">Review the project again</a> after checking Docker to rerun inconclusive checks.</p>
      )}
    </section>
  );
}
