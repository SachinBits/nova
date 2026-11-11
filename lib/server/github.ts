import { uploadLimit } from '../project-review';
import { UploadError } from './project-archive';

export type RepoRef = { owner: string; repo: string; ref?: string };

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/;
const refPattern = /^[A-Za-z0-9._\/-]{1,200}$/;

// Accepts https://github.com/owner/repo, github.com/owner/repo(.git), .../tree/<ref> and owner/repo.
// Only github.com is accepted, and the parts are validated before any URL is built from them.
export function parseRepoUrl(input: string): RepoRef {
  const invalid = new UploadError('Enter a GitHub repository link such as https://github.com/owner/repo.');
  let text = input.trim();
  if (!text || text.length > 400) throw invalid;
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = 'https://github.com/' + text;
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  let url: URL;
  try { url = new URL(text); } catch { throw invalid; }
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) throw invalid;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw invalid;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo === '.' || repo === '..') throw invalid;
  if (parts.length === 2) return { owner, repo };
  if (parts[2] !== 'tree' && parts[2] !== 'commit') throw new UploadError('Link to the repository or to a branch (/tree/<branch>), not to a single file.');
  const ref = parts.slice(3).join('/');
  if (!refPattern.test(ref) || ref.split('/').some((part) => !part || part === '.' || part === '..')) throw invalid;
  return { owner, repo, ref };
}

async function readLimited(response: Response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > uploadLimit) throw new UploadError('The repository archive exceeds the 12 MB limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new UploadError('GitHub returned an empty archive.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > uploadLimit) {
      await reader.cancel();
      throw new UploadError('The repository archive exceeds the 12 MB limit.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

// Downloads the repository as a ZIP. Redirects are followed by hand so the archive can only come from GitHub.
export async function downloadRepo({ owner, repo, ref }: RepoRef) {
  const token = process.env.GITHUB_TOKEN?.trim();
  const path = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/zipball' + (ref ? '/' + ref.split('/').map(encodeURIComponent).join('/') : '');
  let response: Response;
  try {
    response = await fetch('https://api.github.com' + path, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'hex-review',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    });
  } catch {
    throw new UploadError('GitHub could not be reached. Check the network connection and retry.');
  }
  if (response.status === 404) {
    throw new UploadError(ref ? 'Repository or branch not found. Private repositories need GITHUB_TOKEN in .env.' : 'Repository not found. Private repositories need GITHUB_TOKEN in .env.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new UploadError('GitHub rate-limited the download. Add GITHUB_TOKEN to .env or retry later.');
  }
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new UploadError('GitHub did not provide the repository archive (HTTP ' + response.status + ').');
  }
  const target = new URL(location);
  if (target.protocol !== 'https:' || target.hostname !== 'codeload.github.com') throw new UploadError('GitHub redirected to an unexpected host.');
  let archive: Response;
  try {
    archive = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'hex-review' } });
  } catch {
    throw new UploadError('The repository archive could not be downloaded.');
  }
  if (!archive.ok) throw new UploadError('The repository archive could not be downloaded (HTTP ' + archive.status + ').');
  return readLimited(archive);
}

// GitHub wraps every archive in one "owner-repo-<sha>/" folder. Removing it keeps paths project-relative.
export function unwrapArchive(files: Map<string, Buffer>, excludedPaths: string[] = []) {
  const roots = new Set([...files.keys(), ...excludedPaths].map((path) => path.split('/')[0]));
  const [root] = roots;
  if (roots.size !== 1 || ![...files.keys(), ...excludedPaths].every((path) => path.startsWith(root + '/'))) return { files, excludedPaths, commit: undefined };
  const commit = root.match(/-([0-9a-f]{7,40})$/)?.[1];
  const strip = (path: string) => path.slice(root.length + 1);
  return { files: new Map([...files].map(([path, bytes]) => [strip(path), bytes])), excludedPaths: excludedPaths.map(strip), commit };
}
