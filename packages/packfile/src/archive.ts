import { validatePack, type PackIssue, type PackManifest } from '@pr/design-schema';
import { readZip, ZipError } from './zip.js';

/**
 * A Product Pack as it arrives over HTTP (F-GEN-02, F-ADM-01).
 *
 * The CLI importer reads a directory; the admin console has to accept the same thing as one file.
 * This turns that file back into "a manifest and the assets it names", so both paths hand the
 * importer identical arguments and there is only one importer.
 */

export interface PackArchive {
  /** Unvalidated: `validatePack` is the authority, and it runs where the import happens. */
  raw: unknown;
  manifest: PackManifest | null;
  files: Map<string, Uint8Array>;
  issues: ReturnType<typeof validatePack>['issues'];
  publishable: boolean;
  /** Files the manifest names but the archive does not contain. */
  missing: string[];
  /** Files present that nothing in the manifest refers to. */
  unused: string[];
}

export function readPackArchive(bytes: Uint8Array): PackArchive {
  const entries = readZip(bytes);
  const root = commonPrefix(entries.map((entry) => entry.path));

  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const path = root ? entry.path.slice(root.length) : entry.path;
    // Archive noise every zip tool adds. Keeping it would only show up as "unused".
    if (path === '' || path.startsWith('__MACOSX/') || path.endsWith('.DS_Store')) continue;
    files.set(path, entry.bytes);
  }

  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new ZipError('the archive has no manifest.json');

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    throw new ZipError('manifest.json is not valid JSON');
  }

  const validation = validate(raw);
  const declared = validation.manifest ? declaredFiles(validation.manifest) : new Set<string>();

  return {
    raw,
    manifest: validation.manifest ?? null,
    files,
    issues: validation.issues,
    publishable: validation.publishable,
    missing: [...declared].filter((path) => !files.has(path)).sort(),
    unused: [...files.keys()]
      .filter((path) => path !== 'manifest.json' && !declared.has(path))
      .sort(),
  };
}

/**
 * Validation that reports rather than throws.
 *
 * `validatePack` parses first and lets the schema error out, which is right for the importer — it
 * is handed manifests the system already accepted. Here the manifest came from a stranger, and
 * "this is not a pack" is a thing to show them, not a stack trace.
 */
function validate(raw: unknown): { manifest: PackManifest | null; issues: PackIssue[]; publishable: boolean } {
  try {
    const result = validatePack(raw);
    return { manifest: result.manifest, issues: result.issues, publishable: result.publishable };
  } catch (error) {
    const issues = zodIssues(error);
    return {
      manifest: null,
      issues: issues.length ? issues : [
        { severity: 'error', code: 'schema_invalid', path: '', message: 'this is not a pack manifest' },
      ],
      publishable: false,
    };
  }
}

function zodIssues(error: unknown): PackIssue[] {
  const list = (error as { issues?: { path?: unknown[]; message?: string }[] }).issues;
  if (!Array.isArray(list)) return [];

  return list.slice(0, 20).map((issue) => ({
    severity: 'error' as const,
    code: 'schema_invalid' as const,
    path: (issue.path ?? []).join('.'),
    message: issue.message ?? 'invalid',
  }));
}

/** Every path the manifest points at, so the console can say what is missing before importing. */
export function declaredFiles(manifest: PackManifest): Set<string> {
  const paths = new Set<string>();

  for (const product of manifest.products) {
    for (const variant of product.variants) {
      for (const ref of Object.values(variant.assets)) add(paths, ref);
    }
  }
  for (const material of manifest.materials) {
    for (const ref of Object.values(material.maps)) add(paths, ref);
  }

  return paths;
}

/** Asset and texture references are both `{ path }`; tiling and the like are plain numbers. */
function add(paths: Set<string>, ref: unknown): void {
  if (ref && typeof ref === 'object' && typeof (ref as { path?: unknown }).path === 'string') {
    paths.add((ref as { path: string }).path);
  }
}

/**
 * The single folder everything sits in, if there is one.
 *
 * Zipping a directory usually produces `cap-basic/manifest.json` rather than `manifest.json`, and
 * an importer that cared about the difference would reject half the packs anyone sends it.
 */
function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const first = paths[0]!.split('/')[0];
  if (!first) return '';

  const prefix = `${first}/`;
  return paths.every((path) => path.startsWith(prefix)) ? prefix : '';
}
