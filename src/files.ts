import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PolitoClient } from './polito.ts';
import { DownloadFailed, TooLarge } from './polito.ts';

// Upstream shapes, from the PoliTO student OpenAPI spec.
interface UpstreamFile {
  type: 'file';
  id: string;
  name: string;
  sizeInKiloBytes: number;
  mimeType: string;
  createdAt: string;
  checksum: string;
}

interface UpstreamDirectory {
  type: 'directory';
  id: string;
  name: string;
  files: UpstreamEntry[];
}

export type UpstreamEntry = UpstreamFile | UpstreamDirectory;

// Our output shape: one line per file, with the folders it sits in.
export interface FileItem {
  id: string;
  name: string;
  // Folders from the course root, joined with "/". Empty at the root.
  folder: string;
  sizeKB: number;
  mimeType: string;
  createdAt: string;
  checksum: string;
}

// Flattens the course folder tree into a file list, oldest folders first as
// PoliTO sends them. Pass a directory id to list only what's inside it.
export function flattenFiles(tree: UpstreamEntry[], underId?: string): FileItem[] {
  const out: FileItem[] = [];
  const walk = (entries: UpstreamEntry[], folders: string[], inside: boolean) => {
    for (const e of entries) {
      const hit = inside || e.id === underId;
      if (e.type === 'directory') {
        walk(e.files ?? [], [...folders, e.name], hit);
      } else if (hit) {
        out.push({
          id: e.id,
          name: e.name,
          folder: folders.join('/'),
          sizeKB: e.sizeInKiloBytes,
          mimeType: e.mimeType,
          createdAt: e.createdAt,
          checksum: e.checksum,
        });
      }
    }
  };
  walk(tree, [], underId === undefined);
  return out;
}

// Makes a PoliTO file or folder name safe as one path segment: no slashes,
// no "..", no control characters, and short enough for any file system.
export function safeSegment(name: string, fallback: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150)
    .trim();
  return clean || fallback;
}

export interface DownloadResult {
  downloaded: { id: string; path: string; bytes: number }[];
  skipped: { id: string; path: string; reason: string }[];
  failed: { id: string; path: string; error: string }[];
}

// Where each file of a course goes, relative to the course folder. PoliTO
// allows two files with the same name in one folder, and different names can
// clean up to the same one, so colliding files get their id in the name.
// Pass the whole course tree, so a file's path doesn't depend on which other
// files a run asked for.
export function destinations(files: FileItem[]): Map<string, string> {
  const natural = files.map((f) => {
    const folders = f.folder ? f.folder.split('/').map((s, i) => safeSegment(s, `folder-${i}`)) : [];
    return { f, folders, name: safeSegment(f.name, f.id) };
  });
  // Lowercase, because macOS and Windows treat Slides.pdf and slides.pdf as one file.
  const key = (folders: string[], name: string) => path.join(...folders, name).toLowerCase();
  const count = new Map<string, number>();
  for (const n of natural) count.set(key(n.folders, n.name), (count.get(key(n.folders, n.name)) ?? 0) + 1);
  // Every name in use, natural or generated, so a generated name like
  // "Slides (1).pdf" never lands on a file PoliTO already calls that.
  const taken = new Set(natural.map((n) => key(n.folders, n.name)));
  const out = new Map<string, string>();
  for (const { f, folders, name } of natural) {
    let file = name;
    if (count.get(key(folders, name))! > 1) {
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      file = `${base} (${f.id})${ext}`;
      for (let n = 2; taken.has(key(folders, file)); n++) file = `${base} (${f.id}-${n})${ext}`;
      taken.add(key(folders, file));
    }
    out.set(f.id, path.join(...folders, file));
  }
  return out;
}

// Downloads files into `<outDir>/<course> (<id>)/<folders>/<name>`. A file is
// skipped when the last download to its path was the same file with the same
// checksum, and the run stops taking files once their listed sizes would
// pass `maxBytes`.
export async function downloadFiles(
  client: PolitoClient,
  opts: {
    courseId: string;
    courseName: string;
    files: FileItem[];
    // Every file in the course, to keep paths stable. Defaults to `files`.
    allFiles?: FileItem[];
    outDir: string;
    maxBytes: number;
    manifestFile: string;
    force?: boolean;
  },
): Promise<DownloadResult> {
  const manifest = await readManifest(opts.manifestFile);
  const result: DownloadResult = { downloaded: [], skipped: [], failed: [] };
  // The id keeps two courses with the same name apart.
  const courseDir = path.join(path.resolve(opts.outDir), `${safeSegment(opts.courseName, 'course')} (${opts.courseId})`);
  const where = destinations(opts.allFiles ?? opts.files);
  let budget = opts.maxBytes;

  for (const f of opts.files) {
    const dest = path.join(courseDir, where.get(f.id) ?? safeSegment(f.name, f.id));
    // Keyed by path, with the id, so another file landing on the same path never counts as unchanged.
    const record = `${f.id}:${f.checksum}`;
    if (!opts.force && manifest[dest] === record && (await exists(dest))) {
      result.skipped.push({ id: f.id, path: dest, reason: 'unchanged since the last download' });
      continue;
    }
    if (f.sizeKB * 1024 > budget) {
      result.skipped.push({ id: f.id, path: dest, reason: `over the size limit (${Math.round(budget / 1e6)} MB left of ${Math.round(opts.maxBytes / 1e6)} MB)` });
      continue;
    }
    try {
      const { bytes } = await client.download(`/courses/${opts.courseId}/files/${encodeURIComponent(f.id)}`, dest, budget);
      budget -= bytes;
      manifest[dest] = record;
      result.downloaded.push({ id: f.id, path: dest, bytes });
    } catch (err) {
      // Bytes that came over the network count against the run, even when the file didn't make it.
      if (err instanceof TooLarge || err instanceof DownloadFailed) budget = Math.max(0, budget - err.transferred);
      if (err instanceof TooLarge) {
        result.skipped.push({ id: f.id, path: dest, reason: err.message });
      } else {
        result.failed.push({ id: f.id, path: dest, error: (err as Error).message });
      }
    }
  }
  if (result.downloaded.length) await writeManifest(opts.manifestFile, manifest);
  return result;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function readManifest(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // A missing or broken manifest only means files get downloaded again.
    return {};
  }
}

async function writeManifest(file: string, manifest: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // shortcut: two runs at once each write the whole manifest and the last one
  // wins, which only costs a repeat download. Lock the file if that matters.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
