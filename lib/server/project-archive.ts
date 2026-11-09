import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { ZipFile as OutputZip } from 'yazl';
import { buffer } from 'node:stream/consumers';

export class UploadError extends Error {}
const expandedLimit = 32 * 1024 * 1024;

function safeName(entry: Entry) {
  const name = entry.fileName.replace(/\/$/, '');
  const parts = name.split('/');
  if (name.length > 220 || parts.some((part) =>
    !part || part === '.' || part === '..' || /[\\:\u0000-\u001f<>|?*"\u007f]/.test(part)
    || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
  )) throw new UploadError('ZIP contains an unsafe file path.');
  return name;
}

function excluded(name: string) {
  return name.split('/').some((part) =>
    /^(node_modules|\.git|\.next|coverage|\.vercel|__MACOSX)$/i.test(part)
    || /^(\.env($|\.)|\.npmrc$|\.netrc$|\.ssh$|id_(rsa|ed25519)$)/i.test(part)
    || /\.(pem|key|pfx|p12)$/i.test(part),
  );
}

export async function unpackProject(input: Buffer) {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(input, { lazyEntries: true, strictFileNames: true }, (error, result) => {
      if (error) reject(new UploadError('Upload a valid ZIP archive.'));
      else resolve(result);
    });
  });
  const files = new Map<string, Buffer>();
  const seen = new Map<string, { path: string; directory: boolean }>();
  let total = 0;
  let excludedFiles = 0;

  function register(path: string, directory: boolean) {
    const key = path.normalize('NFC').toLowerCase();
    const prior = seen.get(key);
    if (prior && (prior.path !== path || !prior.directory || !directory)) {
      throw new UploadError('ZIP contains conflicting file paths.');
    }
    seen.set(key, { path, directory });
  }

  async function read(entry: Entry) {
    const path = safeName(entry);
    const directory = entry.fileName.endsWith('/');
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) {
      throw new UploadError('ZIP links and special files are unsupported.');
    }
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) register(parts.slice(0, i).join('/'), true);
    register(path, directory);
    if (directory) return;
    if (excluded(path)) { excludedFiles++; return; }
    total += entry.uncompressedSize;
    if (entry.uncompressedSize > 8 * 1024 * 1024 || total > expandedLimit) {
      throw new UploadError('The expanded ZIP exceeds the size limit.');
    }
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value));
    });
    files.set(path, await buffer(stream));
  }

  try {
    if (zip.entryCount > 2500) throw new UploadError('The ZIP has more than 2,500 entries.');
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', (entry) => void read(entry).then(() => zip.readEntry(), reject));
      zip.readEntry();
    });
    return { files, excludedFiles };
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError('The ZIP contains an unreadable or unsupported entry.');
  } finally {
    zip.close();
  }
}

export async function packProject(files: Map<string, Buffer>, report: string) {
  const zip = new OutputZip();
  const collected = buffer(zip.outputStream);
  for (const [path, bytes] of files) zip.addBuffer(bytes, path);
  let reportPath = 'HEX-REVIEW.json';
  const occupied = new Set([...files.keys()].map((path) => path.split('/')[0].toLowerCase()));
  for (let i = 1; occupied.has(reportPath.toLowerCase()); i++) reportPath = 'HEX-REVIEW-' + i + '.json';
  zip.addBuffer(Buffer.from(report), reportPath);
  zip.end();
  return collected;
}
