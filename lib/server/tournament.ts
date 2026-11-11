import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { ProjectUpdate } from '../project-review';
import { type Candidate, type Requirement, type Tournament, requirements, verdict } from '../tournament';
import { fieldSupplyChecks, fieldSupplyVerifier } from './field-supply-checks';
import { packProject } from './project-archive';
import { verifyPythonProject, type Runtime } from './project-tests';

const header = '        self.send_header("Content-Length", str(len(body)))';
const redirect = '        self.send_response(HTTPStatus.SEE_OTHER)';
const cache = '        self.send_header("Cache-Control", "no-store")';
const scoped = '        if urlsplit(self.path).path in {"/cart", "/order"}:\n    ' + cache;
const options = [
  { id: 'broad', label: 'No-store on all responses', edit: cache },
  { id: 'scoped', label: 'No-store on cart and orders', edit: scoped },
  { id: 'broken', label: 'Verifier control: broken checkout', edit: scoped },
];
type Entry = { evidence: Tournament; files: Map<string, Buffer>; app: string; expires: number };
const state = globalThis as typeof globalThis & { hexTournaments?: Map<string, Entry> };
const records = (): Map<string, Entry> => state.hexTournaments ??= new Map<string, Entry>();
const read = (bytes: Buffer) => bytes.toString('utf8').replace(/\r\n/g, '\n');

export async function runTournament(files: Map<string, Buffer>, runtime: Runtime, emit: (update: ProjectUpdate) => void) {
  const matches = [...files].filter(([path, bytes]) => {
    if (posix.basename(path) !== 'app.py' || !files.has(posix.join(posix.dirname(path), 'styles.css'))) return false;
    const source = read(bytes);
    return source.includes('class StoreHandler(BaseHTTPRequestHandler):')
      && source.includes('Field Supply') && source.split(header).length === 2 && source.split(redirect).length === 2;
  });
  if (matches.length !== 1 || [...files.values()].reduce((size, bytes) => size + bytes.length, 0) > 1024 * 1024) return;
  const [app, bytes] = matches[0];
  const source = read(bytes);
  let assetPolicy: string | undefined;
  async function measure(candidate: Map<string, Buffer>, id: string, label: string, control = false): Promise<Candidate> {
    let observed: Record<string, boolean> = {};
    try {
      const result = await verifyPythonProject(candidate, runtime, fieldSupplyVerifier, [
        '/review/' + app, ...(assetPolicy === undefined ? [] : [assetPolicy]),
      ]);
      if (id === 'baseline') assetPolicy = result.assetPolicy;
      observed = result.checks;
    } catch {
      // An interrupted check is inconclusive.
    }
    return { id, label, control, checks: fieldSupplyChecks.map(([key, checkLabel, group]) => ({
      id: key, label: checkLabel, group,
      status: typeof observed[key] !== 'boolean' || (key === 'asset_cache' && assetPolicy === undefined)
        ? 'Inconclusive' : observed[key] ? 'Pass' : 'Fail',
    })) };
  }
  emit({ agent: 'Scout', squad: 'red', text: 'Checking Field Supply with 20 predefined security and behavior assertions.' });
  const baseline = await measure(files, 'baseline', 'Original');
  for (const check of baseline.checks.filter(({ group, status }) => group === 'security' && status === 'Fail')) {
    emit({ agent: 'Scout', squad: 'red', text: 'Baseline failed: ' + check.label + '.' });
  }
  const candidates: Candidate[] = [];
  for (const option of options) {
    const control = option.id === 'broken';
    emit({ agent: 'Patch Engineer', squad: 'blue', text: 'Submitting ' + option.label + '.' });
    let changed = source.replace(header, header + '\n' + option.edit);
    if (control) changed = changed.replace(redirect, '        self.send_response(HTTPStatus.FORBIDDEN)');
    const candidate = await measure(new Map(files).set(app, Buffer.from(changed)), option.id, option.label, control);
    for (const check of candidate.checks) {
      if (baseline.checks.find(({ id }) => id === check.id)?.status === 'Inconclusive') check.status = 'Inconclusive';
    }
    candidates.push(candidate);
    const passed = candidate.checks.filter(({ status }) => status === 'Pass').length;
    emit({ agent: 'Verifier', squad: 'neutral', text: option.label + ' passed ' + passed + ' of ' + candidate.checks.length + ' checks. ' + verdict(candidate, ['checkout', 'assets']) + '.' });
  }
  const evidence = { id: randomUUID(), baseline, candidates, image: runtime.image };
  const entries = records();
  for (const [id, entry] of entries) if (entry.expires <= Date.now()) entries.delete(id);
  while (entries.size >= 16) entries.delete(entries.keys().next().value!);
  entries.set(evidence.id, { evidence, files, app, expires: Date.now() + 3600000 });
  return evidence;
}

export async function exportCandidate(id: string, candidateId: string, selected: Requirement[]) {
  const entry = records().get(id);
  if (!entry || entry.expires <= Date.now()) return;
  const option = options.find(({ id }) => id === candidateId);
  const candidate = entry.evidence.candidates.find(({ id }) => id === candidateId);
  if (!option || !candidate || verdict(candidate, selected) !== 'Qualifies') return;
  const original = read(entry.files.get(entry.app)!);
  const line = original.slice(0, original.indexOf(header)).split('\n').length;
  const patched = original.replace(header, header + '\n' + option.edit);
  const diff = '--- a/' + entry.app + '\n+++ b/' + entry.app + '\n@@ -' + line + ',1 +' + line + ',' + (1 + option.edit.split('\n').length) + ' @@\n '
    + header + '\n' + option.edit.split('\n').map((part) => '+' + part).join('\n') + '\n';
  const report = {
    accepted: candidate.id,
    requirements: selected.map((key) => requirements[key]),
    evidence: entry.evidence,
    verdicts: entry.evidence.candidates.map((item) => ({
      id: item.id, verdict: verdict(item, selected),
      reasons: item.checks.filter(({ group, status }) => (group === 'security' || selected.includes(group)) && status !== 'Pass'),
      ...(item.control ? { control: 'Deliberately broken checkout used to test the verifier.' } : {}),
    })),
    diff,
    rerun: 'Upload the original Field Supply ZIP in Hex with the Python Docker image available and select the same requirements.',
  };
  return packProject(new Map(entry.files).set(entry.app, Buffer.from(patched)), JSON.stringify(report, null, 2) + '\n');
}
