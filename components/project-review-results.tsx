'use client';

import type { ReviewResult } from './project-review-session';

export function ProjectReviewResults({ review }: { review: ReviewResult }) {
  const { report, archive, filename } = review;

  function download() {
    const bytes = Uint8Array.from(atob(archive), (value) => value.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.replace(/\.zip$/i, '') + '-hex-reviewed.zip';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="project-result" aria-label="Project review results">
      <div className="panelTitle review-result-title">
        <div>
          <h2>{filename}</h2>
          <p>{report.framework} · {report.scannedFiles} source files checked · {report.excludedFiles} excluded files</p>
        </div>
        <button className="start" onClick={download}>Download reviewed ZIP</button>
      </div>
      <p><b>Baseline</b> {report.tests.baseline}</p>
      <p><b>Patched copy</b> {report.tests.patched}</p>
      <p><b>AI review</b> {report.ai}</p>
      {report.changes.length > 0 && (
        <details>
          <summary>View applied changes</summary>
          {report.changes.map(({ file, line, before, after }, index) => (
            <div key={index}>
              <code>{file}:{line}</code>
              {before && <pre>- {before}</pre>}
              <pre>+ {after.trim()}</pre>
            </div>
          ))}
        </details>
      )}
      {report.findings.length ? (
        <ul>
          {report.findings.map((item, index) => (
            <li key={index}><p><b>{item.status} · {item.title}</b><br /><code>{item.file}:{item.line}</code><br />{item.detail}</p></li>
          ))}
        </ul>
      ) : <p>No findings from the checks that ran.</p>}
    </section>
  );
}
