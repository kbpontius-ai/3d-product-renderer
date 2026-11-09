/**
 * Builds the STEP fixtures the CAD importer is tested against.
 *
 * Written by OCCT, which is the point: a STEP file typed by hand would exercise a grammar nobody
 * ships, and the interesting failures in this pipeline are all about what real exporters emit —
 * assemblies, part names, units, tolerances a healer has to fix.
 *
 * Regenerating needs OCCT installed (`pip install cadquery-ocp`), but the fixtures are committed,
 * so running the suite does not. Usage: pnpm fixtures:cad
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./make-fixture-cad.py', import.meta.url));
const python = process.env['CAD_PYTHON'] ?? 'python3';

const result = spawnSync(python, [script], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('could not build the CAD fixtures — is OCCT installed for this interpreter?');
  process.exitCode = 1;
}
