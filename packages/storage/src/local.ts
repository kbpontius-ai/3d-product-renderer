import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertValidKey, contentTypeFor, ObjectNotFound, type Storage, type StoredObject } from './storage.js';

/**
 * Filesystem-backed storage.
 *
 * What development and tests run on, and what a single-node deployment can run on. Keys map to
 * paths under one root; `assertValidKey` is what keeps a key from becoming a path outside it.
 */
export function localStorage(root: string): Storage {
  const pathFor = (key: string): string => {
    assertValidKey(key);
    return join(root, ...key.split('/'));
  };

  return {
    async put(key, bytes, contentType) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      // The type is derived from the key on read, so a mismatch here would be a lie rather than a
      // stored fact. Fail loudly instead of recording something the reader will contradict.
      if (contentType !== contentTypeFor(key)) {
        throw new Error(`content type ${contentType} does not match the key ${key}`);
      }
    },

    async get(key): Promise<StoredObject> {
      const path = pathFor(key);
      try {
        return { bytes: new Uint8Array(await readFile(path)), contentType: contentTypeFor(key) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFound(key);
        throw error;
      }
    },

    async has(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },

    async list(prefix) {
      assertValidKey(prefix);
      const base = join(root, ...prefix.split('/'));
      const found: string[] = [];

      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else found.push(relative(root, path).split(sep).join('/'));
        }
      };

      await walk(base);
      return found.sort();
    },
  };
}

/**
 * Where local storage lives when nothing says otherwise.
 *
 * Anchored to the workspace, not to the working directory: the web app runs from `apps/web`, the
 * worker from `apps/worker-render`, and a relative default would give them each a different store —
 * which shows up as a renderer that cannot find a mesh the catalog swears it imported.
 */
export function defaultStorageRoot(): string {
  const configured = process.env['STORAGE_ROOT'];
  if (configured) return resolve(configured);

  let dir = process.cwd();
  for (let up = 0; up < 6; up++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.tmp', 'storage');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve('.tmp/storage');
}
