import { posix } from 'node:path';
import type { ReviewFinding } from '../project-review';

// Project-level checks for the attacks that dominate modern JavaScript incidents: vulnerable or
// malicious dependencies, install-time scripts, tampered lockfiles, CI workflow abuse and leaked secrets.

type Finding = ReviewFinding;
type Severity = Finding['severity'];
type Dependency = { name: string; version: string; ecosystem: 'npm' | 'PyPI'; file: string; line: number; dev?: boolean };

const text = (files: Map<string, Buffer>, path: string) => files.get(path)?.toString('utf8') ?? '';
const lineOf = (source: string, needle: string) => {
  const index = source.indexOf(needle);
  return index < 0 ? 1 : source.slice(0, index).split('\n').length;
};
const finding = (file: string, line: number, title: string, detail: string, severity: Severity, cwe: string): Finding =>
  ({ file, line, title, detail, severity, cwe, status: 'Review' });

// Frequently installed packages that attackers imitate with near-identical names.
const popular = ['react', 'react-dom', 'express', 'lodash', 'axios', 'chalk', 'commander', 'debug', 'moment', 'request', 'dotenv', 'uuid', 'vue',
  'next', 'typescript', 'webpack', 'eslint', 'jest', 'mocha', 'prettier', 'jquery', 'underscore', 'async', 'bluebird', 'yargs', 'minimist',
  'body-parser', 'cors', 'mongoose', 'mongodb', 'mysql', 'mysql2', 'pg', 'redis', 'ioredis', 'socket.io', 'ws', 'jsonwebtoken', 'bcrypt',
  'bcryptjs', 'passport', 'nodemailer', 'cheerio', 'puppeteer', 'sharp', 'multer', 'morgan', 'helmet', 'cookie-parser', 'express-session',
  'dayjs', 'date-fns', 'rxjs', 'zod', 'yup', 'joi', 'classnames', 'styled-components', 'tailwindcss', 'postcss', 'autoprefixer', 'vite',
  'rollup', 'esbuild', 'nodemon', 'ts-node', 'fs-extra', 'glob', 'rimraf', 'semver', 'inquirer', 'ora', 'node-fetch', 'cross-env', 'colors',
  'electron', 'discord.js', 'openai', 'langchain', 'prisma', 'sequelize', 'knex', 'graphql', 'koa', 'fastify', 'got', 'superagent', 'qs',
  'validator', 'xml2js', 'js-yaml', 'marked', 'handlebars', 'ejs', 'pug', 'nanoid', 'immer', 'redux', 'react-router', 'react-router-dom',
  'swr', 'formidable', 'busboy', 'jsdom', 'playwright', 'vitest', 'chokidar', 'execa', 'npm', 'yarn', 'pnpm'];
const popularSet = new Set(popular);

function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function typosquatOf(name: string) {
  if (popularSet.has(name) || name.startsWith('@') || name.length < 4) return;
  const squash = (value: string) => value.replace(/[-_.]/g, '');
  return popular.find((known) => known.length >= 4 && (distance(name, known) === 1 || (squash(name) === squash(known) && name !== known)));
}

function compareVersions(a: string, b: string) {
  const pa = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function manifests(files: Map<string, Buffer>) {
  return [...files.keys()].filter((path) => /(^|\/)package\.json$/.test(path));
}

function dependencyEntries(manifest: Record<string, unknown>) {
  const out: [string, string, boolean][] = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const deps = manifest[field];
    if (deps && typeof deps === 'object') for (const [name, spec] of Object.entries(deps)) if (typeof spec === 'string') out.push([name, spec, field === 'devDependencies']);
  }
  return out;
}

// Resolved versions from npm, yarn and pnpm lockfiles; exact pins in package.json and requirements.txt as a fallback.
function collectDependencies(files: Map<string, Buffer>) {
  const deps: Dependency[] = [];
  const seen = new Set<string>();
  const add = (dep: Dependency) => {
    const key = dep.ecosystem + ':' + dep.name + '@' + dep.version;
    if (!seen.has(key) && /^\d+\.\d+/.test(dep.version)) { seen.add(key); deps.push(dep); }
  };
  for (const [path] of files) {
    const base = posix.basename(path);
    const source = base === 'package-lock.json' || base === 'npm-shrinkwrap.json' || base === 'yarn.lock' || base === 'pnpm-lock.yaml' || /^requirements.*\.txt$/.test(base) ? text(files, path) : '';
    if (!source) continue;
    if (base.endsWith('.json')) {
      try {
        const lock = JSON.parse(source) as { packages?: Record<string, { version?: string; dev?: boolean }>; dependencies?: Record<string, unknown> };
        if (lock.packages) {
          for (const [key, value] of Object.entries(lock.packages)) {
            if (!key || !value?.version) continue;
            const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
            add({ name, version: value.version, ecosystem: 'npm', file: path, line: lineOf(source, '"' + key + '"'), dev: value.dev });
          }
        } else if (lock.dependencies) {
          const walk = (tree: Record<string, unknown>) => {
            for (const [name, value] of Object.entries(tree)) {
              const entry = value as { version?: string; dev?: boolean; dependencies?: Record<string, unknown> };
              if (entry?.version) add({ name, version: entry.version, ecosystem: 'npm', file: path, line: lineOf(source, '"' + name + '"'), dev: entry.dev });
              if (entry?.dependencies) walk(entry.dependencies);
            }
          };
          walk(lock.dependencies);
        }
      } catch {
        // An unreadable lockfile is reported by the lockfile checks below.
      }
    } else if (base === 'yarn.lock') {
      for (const match of source.matchAll(/^"?(@?[^@\s"]+)@[^\n]*:\n\s+version:? "?([^"\n]+)"?/gm)) {
        add({ name: match[1], version: match[2], ecosystem: 'npm', file: path, line: lineOf(source, match[0]) });
      }
    } else if (base === 'pnpm-lock.yaml') {
      for (const match of source.matchAll(/^\s{2}'?\/?(@?[^@\s'/]+(?:\/[^@\s']+)?)@(\d[^:'(\s]*)/gm)) {
        add({ name: match[1], version: match[2], ecosystem: 'npm', file: path, line: lineOf(source, match[0]) });
      }
    } else {
      for (const match of source.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*==\s*([\w.]+)/gm)) {
        add({ name: match[1].toLowerCase(), version: match[2], ecosystem: 'PyPI', file: path, line: lineOf(source, match[0]) });
      }
    }
  }
  // Exact pins in manifests that have no lockfile beside them.
  for (const path of manifests(files)) {
    const dir = posix.dirname(path);
    const locked = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'].some((lock) => files.has(dir === '.' ? lock : dir + '/' + lock));
    if (locked) continue;
    try {
      const source = text(files, path);
      for (const [name, spec, dev] of dependencyEntries(JSON.parse(source))) {
        if (/^\d+\.\d+\.\d+$/.test(spec)) add({ name, version: spec, ecosystem: 'npm', file: path, line: lineOf(source, '"' + name + '"'), dev });
      }
    } catch {
      // Malformed manifests are skipped.
    }
  }
  return deps;
}

type OsvVuln = {
  id: string; summary?: string; aliases?: string[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { introduced?: string; fixed?: string }[] }[] }[];
};

const severityOf = (vuln: OsvVuln): Severity => {
  const level = (vuln.database_specific?.severity ?? '').toUpperCase();
  return level === 'CRITICAL' ? 'Critical' : level === 'HIGH' ? 'High' : level === 'LOW' ? 'Low' : 'Medium';
};
const rank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

function fixedVersion(vuln: OsvVuln, dep: Dependency) {
  const fixes: string[] = [];
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name?.toLowerCase() !== dep.name.toLowerCase()) continue;
    for (const range of affected.ranges ?? []) {
      let introduced = '0';
      for (const event of range.events ?? []) {
        if (event.introduced) introduced = event.introduced;
        if (event.fixed && compareVersions(dep.version, introduced) >= 0 && compareVersions(dep.version, event.fixed) < 0) fixes.push(event.fixed);
      }
    }
  }
  return fixes.sort(compareVersions)[0];
}

// Known-vulnerable versions from OSV.dev. Only package names and versions leave the machine, never source.
async function knownVulnerabilities(deps: Dependency[]) {
  const findings: Finding[] = [];
  if (!deps.length) return { findings, status: 'No resolved dependency versions to check.' };
  const batch = deps.slice(0, 3000);
  const results: { vulns?: { id: string }[] }[] = [];
  for (let i = 0; i < batch.length; i += 1000) {
    const response = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ queries: batch.slice(i, i + 1000).map((dep) => ({ package: { name: dep.name, ecosystem: dep.ecosystem }, version: dep.version })) }),
    });
    if (!response.ok) throw new Error('OSV HTTP ' + response.status);
    results.push(...((await response.json() as { results?: { vulns?: { id: string }[] }[] }).results ?? []));
  }
  const hits = batch.map((dep, i) => ({ dep, ids: (results[i]?.vulns ?? []).map(({ id }) => id) })).filter(({ ids }) => ids.length);
  const details = new Map<string, OsvVuln>();
  const wanted = [...new Set(hits.flatMap(({ ids }) => ids))].slice(0, 40);
  await Promise.all(wanted.map(async (id) => {
    try {
      const detail = await fetch('https://api.osv.dev/v1/vulns/' + encodeURIComponent(id), { signal: AbortSignal.timeout(10000) });
      if (detail.ok) details.set(id, await detail.json() as OsvVuln);
    } catch {
      // A missing detail still leaves the advisory ID in the finding.
    }
  }));
  // One finding per package: several installed versions of the same package are listed together.
  const grouped = new Map<string, { dep: Dependency; ids: string[]; versions: string[] }>();
  for (const { dep, ids } of hits) {
    const group = grouped.get(dep.ecosystem + ':' + dep.name);
    if (!group) { grouped.set(dep.ecosystem + ':' + dep.name, { dep, ids: [...ids], versions: [dep.version] }); continue; }
    group.versions.push(dep.version);
    for (const id of ids) if (!group.ids.includes(id)) group.ids.push(id);
    if (!dep.dev) group.dep = { ...group.dep, dev: false };
  }
  for (const { dep, ids, versions } of grouped.values()) {
    const vulns = ids.map((id) => details.get(id) ?? { id });
    const worst = vulns.map(severityOf).sort((a, b) => rank[a] - rank[b])[0] ?? 'Medium';
    const fixes = vulns.flatMap((vuln) => versions.map((version) => fixedVersion(vuln, { ...dep, version }))).filter((value): value is string => !!value).sort(compareVersions);
    const fix = fixes.at(-1);
    const named = vulns.slice(0, 3).map((vuln) => (vuln.aliases?.find((alias) => alias.startsWith('CVE-')) ?? vuln.id) + (vuln.summary ? ' (' + vuln.summary.slice(0, 90) + ')' : '')).join('; ');
    findings.push(finding(dep.file, dep.line, 'Vulnerable dependency: ' + dep.name + '@' + versions.sort(compareVersions).join(', '),
      ids.length + ' known advisor' + (ids.length === 1 ? 'y' : 'ies') + ': ' + named + (ids.length > 3 ? '; …' : '') + '.'
      + (fix ? ' Upgrade to ' + dep.name + '@' + fix + ' or later.' : ' No fixed version is listed; consider replacing the package.')
      + (dep.dev ? ' Dev dependency: exposure is limited to build and CI machines.' : ''),
      dep.dev && rank[worst] < 2 ? 'Medium' : worst, 'CWE-1395'));
  }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { findings: findings.slice(0, 25), status: 'Checked ' + batch.length + ' resolved dependencies against OSV.dev: ' + grouped.size + ' vulnerable package(s)' + (grouped.size > 25 ? ', the 25 most severe are listed.' : '.') };
}

const suspiciousScript = /\b(curl|wget|Invoke-WebRequest|iwr|powershell|bash\s+-c|sh\s+-c|node\s+-e|python\s+-c|eval|base64|\/dev\/tcp|nc\s+-|https?:\/\/)/i;

function manifestChecks(files: Map<string, Buffer>) {
  const findings: Finding[] = [];
  for (const path of manifests(files)) {
    const source = text(files, path);
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(source); } catch { continue; }
    const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
    for (const hook of ['preinstall', 'install', 'postinstall', 'preuninstall', 'prepare']) {
      const command = scripts[hook];
      if (typeof command === 'string' && suspiciousScript.test(command)) {
        findings.push(finding(path, lineOf(source, '"' + hook + '"'), 'Suspicious install script',
          'The ' + hook + ' script runs automatically on npm install and downloads or evaluates code. This is how worms such as Shai-Hulud spread. Remove it or move the step to an explicit command.',
          'High', 'CWE-506'));
      }
    }
    for (const [name, spec] of dependencyEntries(manifest)) {
      const line = lineOf(source, '"' + name + '"');
      const lookalike = typosquatOf(name);
      if (lookalike) {
        findings.push(finding(path, line, 'Possible typosquatted package: ' + name,
          '"' + name + '" is one character away from the popular package "' + lookalike + '". Confirm this is the intended package before installing.', 'High', 'CWE-1357'));
      }
      if (/^(\*|latest|x|)$/i.test(spec.trim())) {
        findings.push(finding(path, line, 'Unpinned dependency: ' + name, 'Version "' + spec + '" installs whatever is published next, including a hijacked release. Pin a version range.', 'Medium', 'CWE-1357'));
      } else if (/^(http:|git\+http:|git:)/i.test(spec)) {
        findings.push(finding(path, line, 'Dependency fetched without TLS: ' + name, 'The source "' + spec + '" can be tampered with in transit. Use the npm registry or an https URL pinned to a commit.', 'High', 'CWE-494'));
      } else if (/^(https:|git\+https:|github:|[\w-]+\/[\w.-]+(#.*)?$)/i.test(spec) && !/#[0-9a-f]{40}$/i.test(spec)) {
        findings.push(finding(path, line, 'Dependency from a mutable URL: ' + name, 'The source "' + spec + '" is not pinned to a commit, so its content can change without a version bump.', 'Medium', 'CWE-494'));
      }
    }
    const dir = posix.dirname(path);
    const hasDeps = dependencyEntries(manifest).length > 0;
    const locked = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'].some((lock) => files.has(dir === '.' ? lock : dir + '/' + lock));
    if (hasDeps && !locked) {
      findings.push(finding(path, 1, 'No lockfile committed', 'Without a lockfile every install can resolve different, possibly compromised, versions. Commit package-lock.json and install with npm ci.', 'Low', 'CWE-1357'));
    }
  }
  return findings;
}

function lockfileChecks(files: Map<string, Buffer>) {
  const findings: Finding[] = [];
  for (const [path] of files) {
    if (!/(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path)) continue;
    const source = text(files, path);
    let lock: { packages?: Record<string, { resolved?: string; hasInstallScript?: boolean; dev?: boolean }> };
    try { lock = JSON.parse(source); } catch { continue; }
    const scripted: string[] = [];
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (!key) continue;
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (entry.hasInstallScript) scripted.push(name);
      const resolved = entry.resolved;
      if (!resolved) continue;
      if (/^http:/i.test(resolved)) {
        findings.push(finding(path, lineOf(source, resolved), 'Lockfile entry over plain HTTP: ' + name, 'This package is downloaded without TLS and can be swapped in transit.', 'High', 'CWE-494'));
      } else if (/^https:/i.test(resolved) && !/^https:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com|npm\.pkg\.github\.com)\//i.test(resolved)) {
        findings.push(finding(path, lineOf(source, resolved), 'Lockfile resolves outside the npm registry: ' + name,
          'Resolved from ' + new URL(resolved).host + '. Lockfile injection swaps a trusted name for an attacker tarball; confirm this host is your registry.', 'Medium', 'CWE-494'));
      }
    }
    if (scripted.length) {
      findings.push(finding(path, 1, scripted.length + ' dependenc' + (scripted.length === 1 ? 'y runs' : 'ies run') + ' install scripts',
        'Install scripts execute with your user and CI permissions: ' + scripted.slice(0, 8).join(', ') + (scripted.length > 8 ? ', …' : '') + '. Install with npm ci --ignore-scripts where possible.', 'Low', 'CWE-829'));
    }
  }
  return findings.slice(0, 20);
}

const untrustedContext = /\$\{\{\s*(github\.event\.(issue\.(title|body)|pull_request\.(title|body|head\.ref|head\.label)|comment\.body|review\.body|review_comment\.body|head_commit\.(message|author\.(name|email))|commits\b[^}]*\.(message|author)|discussion\.(title|body)|pages\b[^}]*page_name)|github\.head_ref)\b[^}]*\}\}/;

function workflowChecks(files: Map<string, Buffer>) {
  const findings: Finding[] = [];
  for (const [path] of files) {
    if (!/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) continue;
    const source = text(files, path);
    const lines = source.split(/\r?\n/);
    const target = /(^|\s|\[|,)pull_request_target\b/.test(source);
    let block = -1;
    lines.forEach((line, i) => {
      const indent = line.search(/\S/);
      const start = line.match(/^(\s*)(?:-\s*)?(run|script):\s*(.*)$/);
      if (start) block = /^[|>]/.test(start[3].trim()) ? start[1].length : -1;
      else if (block >= 0 && indent >= 0 && indent <= block) block = -1;
      const inScript = !!start || block >= 0;
      if (inScript && untrustedContext.test(line)) {
        findings.push(finding(path, i + 1, 'Workflow script injection',
          'Attacker-controlled text (an issue, PR title, branch name or commit message) is pasted into a shell script. Pass it through env: and quote the variable instead.', 'High', 'CWE-78'));
      }
      const uses = line.match(/^\s*-?\s*uses:\s*['"]?([\w.-]+)\/([\w.\/-]+)@([^\s'"#]+)/);
      if (uses && !/^(actions|github)$/i.test(uses[1]) && !/^[0-9a-f]{40}$/i.test(uses[3])) {
        findings.push(finding(path, i + 1, 'Third-party action not pinned: ' + uses[1] + '/' + uses[2],
          'The tag "' + uses[3] + '" can be moved to malicious code, as happened with tj-actions/changed-files in 2025. Pin the action to a full commit SHA.', 'Medium', 'CWE-829'));
      }
      if (target && /^\s*ref:\s*.*github\.(event\.pull_request\.head\.(sha|ref)|head_ref)/.test(line)) {
        findings.push(finding(path, i + 1, 'pull_request_target checks out untrusted code',
          'This workflow runs with repository secrets and checks out the pull request head, so any fork can run code with those secrets (a "pwn request"). Use pull_request, or never build the checked-out code.', 'Critical', 'CWE-829'));
      }
      if (/^\s*permissions:\s*write-all\b/.test(line)) {
        findings.push(finding(path, i + 1, 'Workflow token has write-all permissions', 'A compromised step can push code or publish releases. Grant only the permissions each job needs.', 'Medium', 'CWE-250'));
      }
    });
  }
  return findings.slice(0, 20);
}

function secretFileChecks(excludedPaths: string[]) {
  const findings: Finding[] = [];
  for (const path of excludedPaths) {
    const base = posix.basename(path);
    if (/^\.env(\.[\w-]+)?$/i.test(base) && !/\.(example|sample|template|dist|defaults?)$/i.test(base)) {
      findings.push(finding(path, 1, 'Environment file committed', 'This file usually holds live credentials and is now in the repository history. Rotate its secrets and add it to .gitignore. Hex did not read it.', 'High', 'CWE-540'));
    } else if (/\.(pem|key|pfx|p12)$/i.test(base) || /^id_(rsa|ed25519)$/i.test(base)) {
      findings.push(finding(path, 1, 'Private key committed', 'Anyone with repository access holds this key. Revoke it and remove it from history. Hex did not read it.', 'High', 'CWE-321'));
    } else if (/^\.npmrc$/i.test(base)) {
      findings.push(finding(path, 1, 'npm configuration committed', 'Committed .npmrc files often contain registry auth tokens. Confirm it holds none. Hex did not read it.', 'Medium', 'CWE-522'));
    }
  }
  return findings.slice(0, 10);
}

export async function supplyChainReview(files: Map<string, Buffer>, excludedPaths: string[]) {
  const findings = [...secretFileChecks(excludedPaths), ...manifestChecks(files), ...lockfileChecks(files), ...workflowChecks(files)];
  let status: string;
  try {
    const result = await knownVulnerabilities(collectDependencies(files));
    findings.push(...result.findings);
    status = result.status;
  } catch {
    status = 'OSV.dev could not be reached; known-vulnerability lookup skipped.';
  }
  return { findings, status };
}
