import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { TestResult } from '../project-review';

const exec = promisify(execFile);
const image = 'node:24-bookworm-slim';
const runner = `
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
let count = 0;
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) check(path);
    else if (/\\.[cm]?js$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'ignore', timeout: 3000 });
      if (result.status !== 0) { console.log('HEX_SYNTAX_FAILED'); process.exit(2); }
      count++;
    }
  }
}
check('/review');
console.log('HEX_SYNTAX_CHECKED=' + count);
if (process.argv[1] !== 'tests') process.exit(0);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`;

export async function dockerReady() {
  try {
    const result = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 5000, windowsHide: true });
    const id = result.stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  } catch {
    // The route reports setup steps to the operator.
  }
}

// The TAP summary prints last, so the final match cannot be spoofed by earlier test output.
function tapCount(stdout: string, label: 'pass' | 'fail') {
  return Number([...stdout.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))].at(-1)?.[1] ?? 0);
}

function syntaxCount(stdout: string) {
  return Number(stdout.match(/^HEX_SYNTAX_CHECKED=(\d+)$/m)?.[1] ?? 0);
}

export async function isolatedTests(files: Map<string, Buffer>, manifest: string | undefined, imageId: string): Promise<TestResult> {
  const root = manifest ? posix.dirname(manifest) : '.';
  const prefix = root === '.' ? '' : root + '/';
  const hasTests = [...files.keys()].some((path) => path.startsWith(prefix)
    && /(^|\/)(?:test\/.*|test|[^/]+[.-](?:test|spec))\.(?:[cm]?js)$/.test(path.slice(prefix.length)));

  const folder = await mkdtemp(join(tmpdir(), 'hex-review-'));
  const name = 'hex-review-' + randomUUID();
  try {
    if (process.platform !== 'win32') await chmod(folder, 0o755);
    for (const [path, data] of files) {
      const location = join(folder, ...path.split('/'));
      await mkdir(dirname(location), { recursive: true });
      await writeFile(location, data);
    }
    const { stdout } = await exec('docker', [
      'run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000',
      '--memory=384m', '--cpus=1', '--pids-limit=64', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m',
      '--mount', 'type=bind,source=' + folder + ',target=/review,readonly',
      '--workdir', '/review/' + prefix, '--entrypoint=node', imageId,
      '-e', runner, '--', hasTests ? 'tests' : 'syntax-only',
    ], { timeout: 45000, maxBuffer: 128 * 1024, windowsHide: true });
    const jsChecked = syntaxCount(stdout);
    const pass = tapCount(stdout, 'pass');
    return {
      syntaxOk: true, jsChecked, pass, fail: tapCount(stdout, 'fail'),
      summary: 'Docker syntax checks passed for ' + jsChecked + ' JS file(s). '
        + (pass ? pass + ' Node test(s) completed.' : 'No compatible Node tests ran.'),
    };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    if (stdout.includes('HEX_SYNTAX_FAILED')) return { syntaxOk: false, jsChecked: 0, pass: 0, fail: 0, summary: 'Failed. Node reported a syntax error in the Docker check.' };
    if (stdout.includes('HEX_SYNTAX_CHECKED=')) return {
      syntaxOk: true, jsChecked: syntaxCount(stdout), pass: tapCount(stdout, 'pass'), fail: tapCount(stdout, 'fail'),
      summary: 'Docker syntax checks passed. Project tests failed or exceeded the sandbox limits.',
    };
    throw new Error('Docker could not finish verification. Check the Docker engine and local image.');
  } finally {
    await exec('docker', ['rm', '-f', name], { timeout: 5000, windowsHide: true }).catch(() => {});
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}
