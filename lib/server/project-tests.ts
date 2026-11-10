import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { TestResult } from '../project-review';

const exec = promisify(execFile);
const nodeImage = 'node:24-bookworm-slim';
const pythonImage = 'python:3.12-slim';

export type Runtime = { image: string; kind: 'node' | 'python' };

const nodeRunner = `
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

// py_compile every .py; on request, run unittest discover and emit machine-readable counts. unittest only (no pytest).
const pythonRunner = `
import os, sys, subprocess, unittest
py = []
for base, _dirs, files in os.walk('/review'):
    if '__pycache__' in base:
        continue
    for f in files:
        if f.endswith('.py'):
            py.append(os.path.join(base, f))
for f in py:
    if subprocess.run([sys.executable, '-m', 'py_compile', f]).returncode != 0:
        print('HEX_SYNTAX_FAILED')
        sys.exit(2)
print('HEX_SYNTAX_CHECKED=' + str(len(py)))
if 'tests' not in sys.argv:
    sys.exit(0)
start = os.environ.get('HEX_TEST_DIR', '/review')
loader = unittest.TestLoader()
def flatten(t):
    if isinstance(t, unittest.TestSuite):
        for x in t:
            yield from flatten(x)
    else:
        yield t
suite = unittest.TestSuite()
seen = set()
for pat in ('test*.py', '*_test.py'):
    try:
        found = loader.discover(start, pattern=pat, top_level_dir=start)
    except Exception:
        continue
    for case in flatten(found):
        cid = case.id()
        if cid not in seen:
            seen.add(cid)
            suite.addTest(case)
res = unittest.TextTestRunner(verbosity=0, stream=sys.stderr).run(suite)
print('HEX_PY_RAN=%d HEX_PY_FAIL=%d HEX_PY_ERR=%d' % (res.testsRun, len(res.failures), len(res.errors)))
sys.exit(0 if res.wasSuccessful() else 1)
`;

async function imageId(image: string) {
  try {
    const result = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 5000, windowsHide: true });
    const id = result.stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  } catch {
    // The route reports setup steps to the operator.
  }
}

export const dockerReady = () => imageId(nodeImage);
export const pythonReady = () => imageId(pythonImage);

function intCount(stdout: string, re: RegExp) {
  return Number(stdout.match(re)?.[1] ?? 0);
}

// The TAP summary prints last, so the final match cannot be spoofed by earlier test output.
function tapCount(stdout: string, label: 'pass' | 'fail') {
  return Number([...stdout.matchAll(new RegExp('^# ' + label + ' (\\d+)\\s*$', 'gm'))].at(-1)?.[1] ?? 0);
}

async function runContainer(files: Map<string, Buffer>, runtime: Runtime, rootDir: string, mode: string): Promise<{ stdout: string; ok: boolean }> {
  const prefix = rootDir ? rootDir + '/' : '';
  const folder = await mkdtemp(join(tmpdir(), 'hex-review-'));
  const name = 'hex-review-' + randomUUID();
  try {
    if (process.platform !== 'win32') await chmod(folder, 0o755);
    for (const [path, data] of files) {
      const location = join(folder, ...path.split('/'));
      await mkdir(dirname(location), { recursive: true });
      await writeFile(location, data);
    }
    const base = [
      'run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000',
      '--memory=384m', '--cpus=1', '--pids-limit=64', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m',
      '--mount', 'type=bind,source=' + folder + ',target=/review,readonly', '--workdir', '/review/' + prefix,
    ];
    const command = runtime.kind === 'python'
      ? [...base, '--env', 'HEX_TEST_DIR=/review/' + prefix, '--env', 'PYTHONPYCACHEPREFIX=/tmp/pyc', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--entrypoint=python', runtime.image, '-c', pythonRunner, '--', mode]
      : [...base, '--entrypoint=node', runtime.image, '-e', nodeRunner, '--', mode];
    try {
      const { stdout } = await exec('docker', command, { timeout: 45000, maxBuffer: 128 * 1024, windowsHide: true });
      return { stdout, ok: true };
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      // A non-zero exit (failed tests or a syntax error) still prints usable markers on stdout.
      if (typeof stdout === 'string' && (stdout.includes('HEX_SYNTAX_CHECKED=') || stdout.includes('HEX_SYNTAX_FAILED'))) {
        return { stdout, ok: false };
      }
      throw new Error('Docker could not finish verification. Check the Docker engine and local image.');
    }
  } finally {
    await exec('docker', ['rm', '-f', name], { timeout: 5000, windowsHide: true }).catch(() => {});
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

export async function isolatedTests(files: Map<string, Buffer>, rootDir: string, runtime: Runtime): Promise<TestResult> {
  const prefix = rootDir ? rootDir + '/' : '';
  const within = (path: string) => path.startsWith(prefix) && path.slice(prefix.length);
  const hasTests = runtime.kind === 'python'
    ? [...files.keys()].some((path) => { const rel = within(path); return rel && /(^|\/)(?:tests?\/.+|test_[^/]+|[^/]+_test)\.py$/.test(rel); })
    : [...files.keys()].some((path) => { const rel = within(path); return rel && /(^|\/)(?:test\/.*|test|[^/]+[.-](?:test|spec))\.(?:[cm]?js)$/.test(rel); });

  const { stdout, ok } = await runContainer(files, runtime, rootDir, hasTests ? 'tests' : 'syntax-only');
  const python = runtime.kind === 'python';
  if (stdout.includes('HEX_SYNTAX_FAILED')) {
    return { syntaxOk: false, jsChecked: 0, pass: 0, fail: 0, summary: python ? 'Failed. py_compile reported a syntax error.' : 'Failed. Node reported a syntax error in the Docker check.' };
  }
  const checked = intCount(stdout, /^HEX_SYNTAX_CHECKED=(\d+)$/m);
  let pass: number, fail: number;
  if (python) {
    fail = intCount(stdout, /HEX_PY_FAIL=(\d+)/) + intCount(stdout, /HEX_PY_ERR=(\d+)/);
    pass = Math.max(0, intCount(stdout, /HEX_PY_RAN=(\d+)/) - fail);
  } else {
    pass = tapCount(stdout, 'pass');
    fail = tapCount(stdout, 'fail');
  }
  const summary = python
    ? (ok ? 'py_compile passed for ' + checked + ' Python file(s). ' + (pass + fail ? pass + ' unittest(s) ran.' : 'No compatible Python tests ran.')
          : 'py_compile passed. Project tests failed or exceeded the sandbox limits.')
    : (ok ? 'Docker syntax checks passed for ' + checked + ' JS file(s). ' + (pass ? pass + ' Node test(s) completed.' : 'No compatible Node tests ran.')
          : 'Docker syntax checks passed. Project tests failed or exceeded the sandbox limits.');
  return { syntaxOk: true, jsChecked: checked, pass, fail, summary };
}

// Validate a single Python patch by compiling just that file in the python image (no execution).
export async function pyCompile(path: string, content: string, runtime: Runtime) {
  try {
    const { stdout } = await runContainer(new Map([[path, Buffer.from(content)]]), runtime, '', 'syntax-only');
    return stdout.includes('HEX_SYNTAX_CHECKED=') && !stdout.includes('HEX_SYNTAX_FAILED');
  } catch {
    return false;
  }
}
