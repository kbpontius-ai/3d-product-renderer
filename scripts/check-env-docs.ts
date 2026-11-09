/**
 * Every environment variable the code reads is either documented or explicitly excused.
 *
 * The env table in the README went stale the moment the CAD worker landed: ten `CAD_*` variables
 * existed in code and nowhere in the docs, and nothing would ever have said so. Documentation drifts
 * because nothing checks it, so this checks it.
 *
 * A variable passes if it is in the README's table, or listed below with a reason. There is no third
 * option, which is the point — the next variable somebody adds forces a decision rather than being
 * forgotten.
 *
 *   pnpm check:env
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Variables that are read but are not a knob anybody sets.
 *
 * Each needs a reason, and the reason is the review: if you cannot write one, it belongs in the
 * table instead.
 */
const NOT_A_KNOB: Record<string, string> = {
  NODE_ENV: 'set by the runtime and by the build, never by a person',
  NEXT_RUNTIME: 'set by Next.js to say which runtime (nodejs or edge) is loading the instrumentation hook',
  PATH: 'the operating system already owns this one',
  HOME: 'likewise',
  TMPDIR: 'likewise',
  LANG: 'likewise',
  LC_ALL: 'likewise',
  LD_LIBRARY_PATH: 'passed through to the CAD parser so it can find its kernel; not ours to define',
  PYTHONPATH: 'as above',
  PYTHONHOME: 'as above',
  PYTHONHASHSEED: 'set by the supervisor on the parser, for determinism — not a deployment choice',
  OMP_NUM_THREADS: 'derived from CAD_THREADS and set on the child; CAD_THREADS is the documented knob',
  OPENBLAS_NUM_THREADS: 'as above',
  PR_CAD_MEMORY_MB: 'set by the sandbox on the parser it launches; see CAD_SANDBOX',
  PR_CAD_CPU_SECONDS: 'as above',
  PR_CAD_MAX_OUTPUT_MB: 'as above',
  PR_CAD_SANDBOX: 'as above',
  E2E_RENDER_WORKER: 'exported by scripts/e2e.sh so specs can skip themselves; not set by hand',
  E2E_CAD_WORKER: 'as above',
  SOME_FUTURE_TOKEN: 'a fixture inside the sandbox tests, demonstrating that the allow-list holds',
};

const READ = /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]|process\.env\.([A-Z_][A-Z0-9_]*)/g;

/** Tracked TypeScript, from git rather than a directory walk, so build output cannot leak in. */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8' });
  return listed
    .split('\n')
    .filter(Boolean)
    .filter((path) => path.startsWith('packages/') || path.startsWith('apps/') || path.startsWith('scripts/'));
}

function main(): void {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const found = new Map<string, string[]>();

  for (const file of sourceFiles()) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const match of source.matchAll(READ)) {
      const name = match[1] ?? match[2]!;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }

  const undocumented: { name: string; where: string[] }[] = [];
  for (const [name, files] of [...found].sort()) {
    if (name in NOT_A_KNOB) continue;
    // A backticked name anywhere in the README counts: the env table uses them, and so does the
    // prose around the scripts that own their own knobs.
    if (readme.includes(`\`${name}\``)) continue;
    undocumented.push({ name, where: [...new Set(files)] });
  }

  if (undocumented.length === 0) {
    const documented = found.size - Object.keys(NOT_A_KNOB).filter((name) => found.has(name)).length;
    console.log(`env docs: ${documented} documented, ${found.size - documented} excused as internal`);
    return;
  }

  console.error(`${undocumented.length} environment variable(s) are read but not documented:\n`);
  for (const { name, where } of undocumented) {
    console.error(`  ${name}`);
    for (const file of where.slice(0, 3)) console.error(`      ${file}`);
  }
  console.error(
    '\nAdd each to the environment table in README.md, or — if it is not a knob anybody sets —\n' +
      'to NOT_A_KNOB in scripts/check-env-docs.ts with a reason.',
  );
  process.exitCode = 1;
}

main();

export { NOT_A_KNOB };
