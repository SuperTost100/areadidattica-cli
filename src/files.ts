import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PolitoClient } from './polito.ts';
import { TooLarge } from './polito.ts';

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

// Downloads files into `<outDir>/<course>/<folders>/<name>`. A file whose
// checksum matches the last download of the same path is skipped, and the
// run stops taking files once their listed sizes would pass `maxBytes`.
export async function downloadFiles(
  client: PolitoClient,
  opts: {
    courseId: string;
    courseName: string;
    files: FileItem[];
    outDir: string;
    maxBytes: number;
    manifestFile: string;
    force?: boolean;
  },
): Promise<DownloadResult> {
  const manifest = await readManifest(opts.manifestFile);
  const result: DownloadResult = { downloaded: [], skipped: [], failed: [] };
  const courseDir = path.join(path.resolve(opts.outDir), safeSegment(opts.courseName, opts.courseId));
  let budget = opts.maxBytes;

  for (const f of opts.files) {
    const folders = f.folder ? f.folder.split('/').map((s, i) => safeSegment(s, `folder-${i}`)) : [];
    const dest = path.join(courseDir, ...folders, safeSegment(f.name, f.id));
    if (!opts.force && manifest[dest] === f.checksum && (await exists(dest))) {
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
      manifest[dest] = f.checksum;
      result.downloaded.push({ id: f.id, path: dest, bytes });
    } catch (err) {
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
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
