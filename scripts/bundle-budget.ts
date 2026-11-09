/**
 * Bundle budgets, enforced (docs/19-frontend.md, docs/21-build-order.md "Quality").
 *
 * A budget written in a document is a wish. This is the thing that fails a build, which is the only
 * form a budget survives in: the editor loads three.js, a GLTF loader and a shader pipeline, and
 * every one of those grows by accident rather than by decision.
 *
 * Sizes are gzipped, because that is what crosses the network. They will not match a CDN serving
 * brotli to the byte; what matters is that the number is computed the same way every time, so a
 * change of fifty kilobytes is visible as a change of fifty kilobytes.
 *
 *   pnpm bundle:budget          # after pnpm build:web
 */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEXT_DIR = join(process.cwd(), 'apps/web/.next');

/**
 * The budgets, from docs/19-frontend.md.
 *
 * `shell` is what every route pays before it has done anything: the framework, the app layout, the
 * shared client code. A regression here is paid by the sign-in page as much as by the editor.
 *
 * `editor` is the whole of `/design/[id]` — three.js, the loaders and the editor itself. It is
 * allowed to be large. It is not allowed to be large *and* unwatched.
 */
const BUDGET_KB_GZ = {
  shell: 180,
  editor: 700,
} as const;

/** The editor route, which is the one the editor budget is about. */
const EDITOR_ROUTE = '/design/[id]/page';

// Material, zone and orientation authoring have real 3D previews; shared library pages must stay WebGL-free.
const THREE_ROUTES = new Set([
  EDITOR_ROUTE,
  '/design/demo/page',
  '/admin/materials/page',
  '/admin/packs/[id]/zones/page',
  '/admin/packs/[id]/setup/page',
  '/admin/packs/[id]/thumbnails/page',
]);

/** Present in three.js and not much else; enough to tell which chunks carry it. */
const THREE_MARKERS = ['WebGLRenderer', 'PerspectiveCamera'];

interface Manifest {
  pages: Record<string, string[]>;
}

function gzippedBytes(file: string): number {
  try {
    return gzipSync(readFileSync(join(NEXT_DIR, file)), { level: 9 }).byteLength;
  } catch {
    return 0; // A file the manifest names but the build did not emit is the build's problem, not ours.
  }
}

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

function main(): void {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(NEXT_DIR, 'app-build-manifest.json'), 'utf8'),
    ) as Manifest;
  } catch {
    console.error('no build to measure; run `pnpm build:web` first');
    process.exitCode = 1;
    return;
  }

  const routes = Object.entries(manifest.pages).map(([route, files]) => ({
    route,
    files: files.filter((f) => f.endsWith('.js')),
  }));
  if (routes.length === 0) {
    console.error('the build manifest lists no routes; something is wrong with the build');
    process.exitCode = 1;
    return;
  }

  const sizes = new Map<string, number>();
  for (const { files } of routes) {
    for (const file of files) if (!sizes.has(file)) sizes.set(file, gzippedBytes(file));
  }

  const total = (files: string[]) => files.reduce((sum, f) => sum + (sizes.get(f) ?? 0), 0);

  // The shell is what every route has in common — measured rather than named, so it cannot drift
  // out of date when the framework reorganises its chunks.
  const shared = routes
    .map(({ files }) => new Set(files))
    .reduce((a, b) => new Set([...a].filter((f) => b.has(f))));
  const shellBytes = total([...shared]);

  const editor = routes.find((r) => r.route === EDITOR_ROUTE);
  if (!editor) {
    console.error(`the build has no ${EDITOR_ROUTE}; the editor budget cannot be checked`);
    process.exitCode = 1;
    return;
  }
  const editorBytes = total(editor.files);

  const threeChunks = new Set(
    [...sizes.keys()].filter((file) => {
      try {
        const source = readFileSync(join(NEXT_DIR, file), 'utf8');
        return THREE_MARKERS.every((marker) => source.includes(marker));
      } catch {
        return false;
      }
    }),
  );
  const strays = routes
    .filter(({ route, files }) => !THREE_ROUTES.has(route) && files.some((f) => threeChunks.has(f)))
    .map(({ route }) => route);

  const failures: string[] = [];
  const check = (name: string, bytes: number, budgetKb: number) => {
    const over = kb(bytes) > budgetKb;
    const share = Math.round((kb(bytes) / budgetKb) * 100);
    console.log(
      `${over ? 'FAIL' : 'ok  '} ${name.padEnd(8)} ${String(kb(bytes)).padStart(7)} kB gz  of ${budgetKb} (${share}%)`,
    );
    if (over) failures.push(`${name} is ${kb(bytes)} kB gz, over its ${budgetKb} kB budget`);
  };

  check('shell', shellBytes, BUDGET_KB_GZ.shell);
  check('editor', editorBytes, BUDGET_KB_GZ.editor);

  if (strays.length > 0) {
    console.log(`FAIL three.js reached ${strays.length} route(s) that should not have it`);
    failures.push(`three.js is bundled into ${strays.join(', ')}`);
  } else {
    console.log(`ok   three.js confined to ${THREE_ROUTES.size} routes`);
  }

  // The five heaviest routes, always. A passing build that is creeping towards a budget is worth
  // seeing before the build that breaks it.
  console.log('\nheaviest routes:');
  for (const { route, files } of [...routes]
    .sort((a, b) => total(b.files) - total(a.files))
    .slice(0, 5)) {
    console.log(`  ${String(kb(total(files))).padStart(7)} kB gz  ${route}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} budget failure(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nRaising a budget is a decision, not a fix: say why in the commit message.');
    process.exitCode = 1;
  }
}

main();
