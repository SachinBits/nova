'use client';

import { AlertTriangle, Bot, Check, ChevronRight, Download, FileDown, FlaskConical, ShieldAlert, ShieldCheck, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { type ProjectReport, type ReviewFinding, testCounts } from '../lib/project-review';
import type { ReviewResult } from './project-review-session';

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// A self-contained, inline-styled report. Every value drawn from uploaded files is escaped.
function reportHtml(report: ProjectReport, filename: string) {
  const fixed = report.findings.filter((f) => f.status === 'Patched').sort(bySeverity);
  const open = report.findings.filter((f) => f.status !== 'Patched').sort(bySeverity);
  const { baseline: b, patched: p } = report.tests;
  const after = p.pass + p.fail;
  const proven = fixed.length > 0 && after > 0 && p.fail === 0 && b.fail > 0;
  const changesFor = (file: string, line: number) => {
    const same = report.changes.filter((c) => c.file === file);
    const near = same.filter((c) => Math.abs(c.line - line) <= 3);
    return near.length ? near : same.slice(0, 1);
  };
  const card = (f: typeof report.findings[number], fix: boolean) => `
    <article class="card ${fix ? 'fixed' : ''}">
      <div class="head"><span class="sev ${esc(f.severity.toLowerCase())}">${esc(f.severity)}</span> <b>${esc(f.title)}</b> <small>${esc(f.cwe)}${f.verification ? ' · ' + esc(f.verification) : ''}</small></div>
      <p><b>Risk:</b> ${esc(riskOf(f))}</p>
      <p><b>${fix ? 'Fix' : 'How to fix'}:</b> ${esc(fix ? f.detail : howTo(f))}</p>
      <code>${esc(f.file)}:${f.line}</code>
      ${fix ? changesFor(f.file, f.line).map((c) => `<pre>${c.before ? `<span class="del">- ${esc(c.before)}</span>\n` : ''}<span class="add">+ ${esc(c.after.trim())}</span></pre>`).join('') : ''}
    </article>`;
  const section = (title: string, items: typeof report.findings, fix: boolean) => items.length
    ? `<h2>${esc(title)}</h2>${items.map((f) => card(f, fix)).join('')}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hex report — ${esc(filename)}</title><style>
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:32px 20px;color:#1a1a1e;background:#fff}
@media(prefers-color-scheme:dark){body{color:#ececef;background:#161618}.card,.verdict{background:#1f1f22;border-color:#333}pre{background:#111}}
h1{font-size:24px;margin:0 0 4px}.sub{color:#777;margin:0 0 20px}
.verdict{border:1px solid #ddd;border-radius:14px;padding:16px;margin:0 0 20px}
.verdict.proven{border-color:#2fad57}.verdict b{font-size:16px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 24px}
.stat{border:1px solid #ddd;border-radius:12px;padding:12px}.stat strong{display:block;font-size:22px}
.stat small{color:#777}
h2{font-size:16px;margin:22px 0 8px}
.card{border:1px solid #ddd;border-radius:12px;padding:12px 14px;margin:0 0 10px}
.card.fixed{border-left:3px solid #2fad57}.head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sev{font-size:10px;font-weight:700;padding:3px 6px;border-radius:7px;background:#eee}
.sev.critical{color:#c92a3f}.sev.high{color:#b66a19}.sev.medium{color:#8a7400}.sev.low{color:#2f7fd1}
code{background:#f0f0f2;padding:2px 6px;border-radius:5px;font-size:12px}
pre{background:#f6f6f8;border-radius:8px;padding:8px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word}
.del{color:#c92a3f}.add{color:#1d8a44}
dl{display:grid;grid-template-columns:160px 1fr;gap:6px 14px;font-size:13px}dt{color:#777}dd{margin:0}
.ts{color:#999;font-size:12px;margin-top:28px}
</style></head><body>
<h1>Hex security report</h1><p class="sub">${esc(filename)} · ${esc(report.framework)}</p>
<div class="verdict ${proven ? 'proven' : ''}"><b>${esc(fixed.length ? 'Hex found ' + report.findings.length + ' security issue(s) and fixed ' + fixed.length + ' automatically.' : report.findings.length ? 'Hex found ' + report.findings.length + ' security issue(s). None could be fixed safely without a developer.' : 'No security issues found by the checks that ran.')}</b>
<p>${esc(proven ? 'Proof: the project’s own tests went from ' + b.pass + '/' + (b.pass + b.fail) + ' to ' + p.pass + '/' + after + ' passing after the fixes.' : after ? 'The project’s own tests went from ' + b.pass + '/' + (b.pass + b.fail) + ' to ' + p.pass + '/' + after + ' passing.' : 'This project has no tests, so Hex confirmed the fixed code still compiles.')}</p></div>
<div class="stats">
<div class="stat"><strong>${report.findings.length}</strong><small>Security issues found</small></div>
<div class="stat"><strong>${fixed.length}</strong><small>Fixed automatically</small></div>
<div class="stat"><strong>${after ? esc(b.pass + '/' + (b.pass + b.fail) + ' → ' + p.pass + '/' + after) : '—'}</strong><small>Tests passing</small></div>
<div class="stat"><strong>${open.length}</strong><small>Need a developer</small></div>
</div>
${section('Fixed automatically', fixed, true)}
${section('Needs a developer', open, false)}
<h2>Technical details</h2>
<dl>
<dt>Project type</dt><dd>${esc(report.framework)}</dd>
<dt>Files</dt><dd>${report.scannedFiles} scanned · ${report.excludedFiles} skipped</dd>
<dt>Original tests</dt><dd>${esc(b.summary + ' ' + testCounts(b))}</dd>
<dt>Fixed copy tests</dt><dd>${esc(p.summary + ' ' + testCounts(p))}</dd>
<dt>Syntax checks</dt><dd>${p.jsChecked} JS file(s) in Docker · ${report.tsChecked} edited TS/TSX file(s) on the host</dd>
<dt>Fixes kept</dt><dd>${esc(report.kept)}</dd>
<dt>AI reviewer</dt><dd>${esc(report.ai)}</dd>
<dt>Sandbox</dt><dd>Docker with no network, read-only files, no privileges, 384 MB memory</dd>
</dl>
<p class="ts">Generated by Hex on ${esc(new Date().toISOString())}.</p>
</body></html>`;
}

function saveBlob(content: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadArchive(archive: string, filename: string) {
  const bytes = Uint8Array.from(atob(archive), (value) => value.charCodeAt(0));
  saveBlob(bytes, 'application/zip', filename.replace(/\.zip$/i, '') + '-hex-fixed.zip');
}

function exportReport(report: ProjectReport, filename: string) {
  saveBlob(reportHtml(report, filename), 'text/html', filename.replace(/\.zip$/i, '') + '-hex-report.html');
}

// Plain-language risk for viewers who are not security specialists.
const risk: Record<string, string> = {
  'CWE-89': 'User input is pasted straight into a database query, so an attacker can read or change other customers’ data.',
  'CWE-22': 'An attacker can ask for files outside the allowed folder, such as configuration or password files.',
  'CWE-338': 'Security tokens made with Math.random() can be guessed, letting an attacker take over a session.',
  'CWE-798': 'A password or key is written into the code, so anyone who sees the code can use it.',
  'CWE-942': 'Any website can call this API on behalf of a logged-in user.',
  'CWE-78': 'An attacker could run their own commands on the server.',
  'CWE-95': 'Text from outside the app could be executed as code on the server.',
  'CWE-200': 'The server announces which framework it runs, which helps attackers pick known exploits.',
  'CWE-347': 'Login tokens may be accepted without a valid signature, so an attacker could forge one.',
  'CWE-79': 'An attacker could inject a script that runs in other users’ browsers.',
  'CWE-295': 'Encrypted connections accept any certificate, so traffic can be intercepted.',
};
const riskOf = (item: ReviewFinding) => risk[item.cwe] ?? 'The AI reviewer flagged this code as a security weakness. A developer should confirm it.';
// A rejected candidate leaves a status message in detail, which is not advice a developer can act on.
const howTo = ({ detail }: ReviewFinding) => /^Candidate /.test(detail) ? 'Hex tried a fix but the checks rejected it. Change this line by hand, then re-run your tests.' : detail;
const order = { Critical: 0, High: 1, Medium: 2, Low: 3 } as const;
const bySeverity = (a: ReviewFinding, b: ReviewFinding) => order[a.severity] - order[b.severity];

function Stat({ tone, icon, value, label, foot }: { tone: string; icon: ReactNode; value: ReactNode; label: string; foot: ReactNode }) {
  return (
    <div className={'pr-stat ' + tone}>
      <span className="pr-statIcon">{icon}</span>
      <strong>{value}</strong>
      <b>{label}</b>
      <small>{foot}</small>
    </div>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <div className="pr-diff" aria-label="Code change">
      {before && before.split('\n').map((line, i) => <div className="del" key={'d' + i}><span>−</span><code>{line}</code></div>)}
      {after.trim().split('\n').map((line, i) => <div className="add" key={'a' + i}><span>+</span><code>{line}</code></div>)}
    </div>
  );
}

export function ProjectReviewResults({ review }: { review: ReviewResult }) {
  const { report, archive, filename } = review;
  const fixed = report.findings.filter((item) => item.status === 'Patched').sort(bySeverity);
  const open = report.findings.filter((item) => item.status !== 'Patched').sort(bySeverity);
  const { baseline: b, patched: p } = report.tests;
  const before = b.pass + b.fail;
  const after = p.pass + p.fail;
  const counts = (['Critical', 'High', 'Medium', 'Low'] as const)
    .map((level) => [level, report.findings.filter((item) => item.severity === level).length] as const)
    .filter(([, count]) => count > 0);
  const proven = fixed.length > 0 && after > 0 && p.fail === 0 && b.fail > 0;

  const issues = `${report.findings.length} security issue${report.findings.length === 1 ? '' : 's'}`;
  const headline = !report.findings.length
    ? 'No security issues found by the checks that ran.'
    : fixed.length
      ? `Hex found ${issues} and fixed ${fixed.length} automatically.`
      : `Hex found ${issues}. None could be fixed safely without a developer.`;
  const proof = !fixed.length
    ? 'Every issue below shows the exact file and line to fix.'
    : after
      ? proven
        ? `Proof: the project’s own tests went from ${b.pass}/${before} passing to ${p.pass}/${after} passing after the fixes.`
        : `The project’s own tests went from ${b.pass}/${before} to ${p.pass}/${after} passing after the fixes.`
      : 'The project has no tests, so Hex confirmed the fixed code still compiles.';

  function changesFor(item: ReviewFinding) {
    const same = report.changes.filter((change) => change.file === item.file);
    const near = same.filter((change) => Math.abs(change.line - item.line) <= 3);
    return near.length ? near : same.slice(0, 1);
  }

  return (
    <div className="pr-results">
      <div className={'pr-verdict' + (proven ? ' proven' : '')}>
        <span className="pr-verdictIcon">{proven ? <ShieldCheck /> : <ShieldAlert />}</span>
        <div>
          <b>{headline}</b>
          <span>{proof}</span>
        </div>
        <div className="pr-verdictBtns">
          <button className="start" onClick={() => downloadArchive(archive, filename)}>
            <Download size={14} /> Download fixed project
          </button>
          <button className="pr-report" onClick={() => exportReport(report, filename)}>
            <FileDown size={14} /> Export report
          </button>
        </div>
      </div>

      <div className="pr-stats">
        <Stat tone="red" icon={<ShieldAlert size={15} />} value={report.findings.length} label="Security issues found"
          foot={counts.length ? counts.map(([level, count]) => <span key={level} className={'sev ' + level.toLowerCase()}>{count} {level}</span>) : `${report.scannedFiles} files scanned`} />
        <Stat tone="green" icon={<Wrench size={15} />} value={fixed.length} label="Fixed automatically"
          foot={fixed.length ? 'Each fix re-tested in Docker' : 'Only safe, provable fixes are applied'} />
        <Stat tone="blue" icon={<FlaskConical size={15} />}
          value={after ? <><em className={b.fail ? 'bad' : 'good'}>{b.pass}/{before}</em><ChevronRight size={16} /><em className={p.fail ? 'bad' : 'good'}>{p.pass}/{after}</em></> : '—'}
          label="Tests passing: before → after"
          foot={after ? 'The project’s own tests, run in a sealed sandbox' : 'No tests in this project'} />
        <Stat tone="amber" icon={<AlertTriangle size={15} />} value={open.length} label="Need a developer"
          foot="Flagged with the exact file and line" />
      </div>

      {fixed.length > 0 && (
        <section className="pr-section">
          <h3><Wrench size={15} /> Fixed automatically</h3>
          <p className="pr-lead">What Hex changed, and the proof each change works.</p>
          {fixed.map((item, index) => (
            <article className="pr-card fixed" key={index}>
              <div className="pr-cardHead">
                <span className={'sev ' + item.severity.toLowerCase()}>{item.severity}</span>
                <b>{item.title}</b>
                {item.cwe === 'Unclassified' && <span className="pr-tag"><Bot size={11} /> AI-written</span>}
                <span className="pr-proof" title={item.verification}><Check size={12} />{item.verification === 'test-verified' ? 'Tests pass after fix' : 'Compiles cleanly'}</span>
              </div>
              <p><b>Risk:</b> {riskOf(item)}</p>
              <p><b>Fix:</b> {item.detail}</p>
              <code className="pr-loc">{item.file}:{item.line}</code>
              {changesFor(item).map((change, i) => <Diff key={i} before={change.before} after={change.after} />)}
            </article>
          ))}
        </section>
      )}

      {open.length > 0 && (
        <section className="pr-section">
          <h3><AlertTriangle size={15} /> Needs a developer</h3>
          <p className="pr-lead">Hex flags these instead of changing them, because a wrong automatic fix could break the app.</p>
          {open.map((item, index) => (
            <article className="pr-card" key={index}>
              <div className="pr-cardHead">
                <span className={'sev ' + item.severity.toLowerCase()}>{item.severity}</span>
                <b>{item.title}</b>
                {item.cwe === 'Unclassified' ? <span className="pr-tag"><Bot size={11} /> AI reviewer</span> : <small>{item.cwe}</small>}
              </div>
              <p><b>Risk:</b> {riskOf(item)}</p>
              <p><b>How to fix:</b> {howTo(item)}</p>
              <code className="pr-loc">{item.file}:{item.line}</code>
            </article>
          ))}
        </section>
      )}

      <details className="pr-tech">
        <summary>Technical details</summary>
        <dl>
          <dt>Project type</dt><dd>{report.framework}</dd>
          <dt>Files</dt><dd>{report.scannedFiles} scanned · {report.excludedFiles} skipped (credentials, dependencies)</dd>
          <dt>Original tests</dt><dd>{b.summary} {testCounts(b)}</dd>
          <dt>Fixed copy tests</dt><dd>{p.summary} {testCounts(p)}</dd>
          <dt>Syntax checks</dt><dd>{p.jsChecked} JS file(s) with node --check in Docker · {report.tsChecked} edited TS/TSX file(s) with transpileModule on the host</dd>
          <dt>Fixes kept</dt><dd>{report.kept}</dd>
          <dt>AI reviewer</dt><dd>{report.ai}</dd>
          <dt>Sandbox</dt><dd>Docker with no network, read-only files, no privileges, 384 MB memory</dd>
        </dl>
      </details>
    </div>
  );
}
