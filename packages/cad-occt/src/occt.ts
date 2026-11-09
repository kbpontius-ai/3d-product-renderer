import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  DEFAULT_LIMITS,
  type CadImportFailure,
  type CadImporter,
  type CadImportOutcome,
  type CadImportRequest,
  type CadImportResult,
  type CadFailureCode,
  type CadPart,
  type CadProbe,
  type CadStage,
  type Vec3Mm,
} from '@pr/cad';
import { readPartBuffer, writeMesh } from './mesh.js';
import {
  resolveSandbox,
  sandboxCommand,
  sandboxEnv,
  sandboxPolicy,
  type SandboxLimits,
  type SandboxMode,
  type SandboxPolicy,
} from './sandbox.js';

/**
 * OCCT, driven as a subprocess (docs/23-cad-ingestion.md).
 *
 * The arrangement `@pr/blender` uses for Cycles, for the same three reasons. A large native C++
 * parser reading a stranger's file gets a process boundary and, in production, a container with no
 * network. A crash becomes an exit code rather than taking the worker down. And OCCT's
 * LGPL-2.1-with-exception licence is easiest to satisfy by using it unmodified, at arm's length.
 *
 * The script is a real Python file rather than a generated string. Nothing is interpolated into it
 * — the whole request arrives as JSON — so there is no reason to give up Python tooling on it, and
 * "unmodified, in its own process" is a more convincing claim about a file somebody can read.
 */

const SCRIPT = fileURLToPath(new URL('./occt_import.py', import.meta.url));
const PROGRESS = /^PR_PROGRESS (\S+) ([\d.]+)$/;
const CANCEL_POLL_MS = 2000;
const PROBE_TIMEOUT_SEC = 60;
const TAIL_LINES = 25;

export const DEFAULT_PYTHON = process.env['CAD_PYTHON'] ?? 'python3';

export interface OcctOptions {
  /** The interpreter that has OCCT's bindings. A container image pins this; a laptop guesses. */
  pythonPath?: string;
  /** What to do when the kernel will not give us a sandbox. Defaults to `CAD_SANDBOX`. */
  sandbox?: SandboxPolicy;
  /** Overrides the ceilings the parser puts on itself. */
  limits?: Partial<SandboxLimits>;
}

/** What the sidecar reports back. Re-checked by `@pr/cad`'s validator before any of it is stored. */
interface SidecarResult {
  status: 'ok';
  declaredUnit: string | null;
  bboxMm: [number[], number[]];
  parts: {
    name: string | null;
    parentIndex: number | null;
    bboxMm: [number[], number[]] | null;
    triangles: number;
    volumeMm3: number | null;
    watertight: boolean;
  }[];
  repairs: { kind: string; count: number; detail?: string }[];
  meshes: {
    lod: string;
    bufferPath: string;
    triangles: number;
    parts: { partIndex: number; triangles: number }[];
  }[];
  symmetryAxis: number[] | null;
}

interface SidecarFailure {
  status: 'failed';
  failure: CadFailureCode;
  message: string;
}

export function occtLocal(options: OcctOptions = {}): CadImporter {
  const pythonPath = options.pythonPath ?? DEFAULT_PYTHON;
  const policy = options.sandbox ?? sandboxPolicy();

  // Resolved once and remembered. Asking the kernel costs a process, and the answer cannot change
  // while this one is running.
  let sandbox: Promise<{ mode: SandboxMode; warning?: string }> | null = null;
  const confinement = () => (sandbox ??= resolveSandbox(policy));

  return {
    id: 'occt',
    // STEP today. The registry in `@pr/cad` is what makes adding IGES or BREP a matter of teaching
    // the sidecar another reader, rather than teaching the pipeline another format.
    formats: ['step'],

    async probe(): Promise<CadProbe> {
      // Sixty seconds for what looks like a one-line import. OCCT's bindings are tens of megabytes
      // of native code, and the first load on a cold machine genuinely takes ten or fifteen — a
      // tighter budget makes a loaded CI box report "no kernel" and silently skip its own suite.
      const probe = await run(pythonPath, ['-c', PROBE_SCRIPT], PROBE_TIMEOUT_SEC);
      const version = /PR_OCCT ([\d.]+)/.exec(probe.out)?.[1];

      if (probe.code !== 0 || !version) {
        return {
          available: false,
          features: {},
          reason: `${pythonPath} cannot import OCCT's bindings — install cadquery-ocp or pythonocc-core`,
        };
      }
      // Reported, not assumed. A deployment that lost its sandbox to a kernel upgrade should be
      // able to see that in a log line rather than in an incident.
      let confined = false;
      let reason: string | undefined;
      try {
        const resolved = await confinement();
        confined = resolved.mode === 'namespace';
        reason = resolved.warning;
      } catch (error) {
        return {
          available: false,
          features: {},
          reason: error instanceof Error ? error.message : 'no sandbox',
        };
      }

      return {
        available: true,
        version,
        // Named rather than assumed, so a build without one degrades instead of failing a job.
        features: {
          heal: /PR_HEAL 1/.test(probe.out),
          assemblyNames: /PR_XCAF 1/.test(probe.out),
          sandbox: confined,
        },
        ...(reason ? { reason } : {}),
      };
    },

    async import(request: CadImportRequest): Promise<CadImportOutcome> {
      const started = Date.now();
      const fail = (
        failure: CadFailureCode,
        message: string,
        tail: string[] = [],
      ): CadImportFailure => ({
        status: 'failed',
        importerId: 'occt',
        failure,
        message,
        seconds: elapsed(started),
        tail,
      });

      if (!this.formats.includes(request.format)) {
        return fail('unsupported_format', `this importer reads ${this.formats.join(', ')}`);
      }
      // Asked before the process is launched, not only while it runs. A job cancelled between being
      // claimed and being started would otherwise cost a full import nobody is waiting for.
      if (request.shouldCancel && (await request.shouldCancel()))
        return fail('canceled', 'canceled');

      const scratch = resolve(request.scratchDir);
      await mkdir(scratch, { recursive: true });
      const requestPath = join(scratch, 'request.json');
      const resultPath = join(scratch, 'result.json');

      await writeFile(
        requestPath,
        JSON.stringify({
          sourcePath: resolve(request.sourcePath),
          scratchDir: scratch,
          resultPath,
          limits: request.limits ?? DEFAULT_LIMITS,
          lods: request.lods.map((lod) => ({ ...lod })),
        }),
        'utf8',
      );

      // Everything past this line is the parser's problem, and the parser is confined before it
      // ever sees the file.
      const { mode } = await confinement();
      const confined = sandboxCommand(pythonPath, [SCRIPT, requestPath], {
        mode,
        // The wall clock the supervisor enforces and the CPU ceiling the parser puts on itself are
        // different questions; keeping them in step means a busy job dies at roughly the same
        // moment a stuck one does, rather than long after. An explicit option still wins.
        limits: { cpuSeconds: Math.ceil(request.timeoutSec * 1.2), ...options.limits },
      });

      const outcome = await run(confined.command, confined.argv, request.timeoutSec, {
        env: confined.env,
        ...(request.threads ? { threads: request.threads } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        ...(request.shouldCancel ? { shouldCancel: request.shouldCancel } : {}),
      });

      if (outcome.canceled) return fail('canceled', 'canceled', outcome.tail);
      if (outcome.timedOut)
        return fail('timeout', `took longer than ${request.timeoutSec}s`, outcome.tail);
      // Names the command that actually failed: with a sandbox in front, that is `unshare`, and
      // "could not start python3" would send somebody looking in the wrong place.
      if (outcome.spawnFailed) {
        return fail('importer_unavailable', `could not start ${confined.command}`, outcome.tail);
      }

      let reported: SidecarResult | SidecarFailure;
      try {
        reported = JSON.parse(await readFile(resultPath, 'utf8')) as SidecarResult | SidecarFailure;
      } catch {
        // No result file at all: the process died before it could write one, which is a crash
        // whatever the exit code says. The tail is the only evidence there is, so it goes back.
        return fail(
          'importer_crash',
          'the importer stopped without reporting a result',
          outcome.tail,
        );
      }

      if (reported.status === 'failed')
        return fail(reported.failure, reported.message, outcome.tail);

      const meshes = [];
      for (const mesh of reported.meshes) {
        const blocks = readPartBuffer(await readFile(mesh.bufferPath));
        meshes.push(
          await writeMesh({
            lod: mesh.lod,
            outputDir: request.outputDir,
            parts: parts(reported),
            blocks,
            partIndices: mesh.parts.map((entry) => entry.partIndex),
          }),
        );
      }

      const result: CadImportResult = {
        status: 'ok',
        importerId: 'occt',
        importerVersion: (await this.probe()).version ?? 'unknown',
        format: request.format,
        declaredUnit: reported.declaredUnit,
        // OCCT converts to millimetres as it reads, so a file that declared a unit did not need the
        // caller's assumption. One that declared none did.
        unitAssumed: reported.declaredUnit === null && request.assumeUnit !== undefined,
        bboxMm:
          meshes.find((mesh) => mesh.lod === 'render')?.bboxMm ??
          meshes[0]?.bboxMm ??
          vec3Pair(reported.bboxMm),
        parts: parts(reported),
        repairs: reported.repairs.map((repair) => ({
          kind: isRepairKind(repair.kind) ? repair.kind : 'other',
          count: repair.count,
          ...(repair.detail ? { detail: repair.detail } : {}),
        })),
        meshes,
        symmetryAxis: reported.symmetryAxis ? vec3(reported.symmetryAxis) : null,
        seconds: elapsed(started),
        tail: outcome.tail,
      };

      return result;
    },
  };
}

/** Asks the interpreter what it has, in one line, without loading the whole importer. */
const PROBE_SCRIPT = [
  'import sys',
  'try:',
  '    from OCP.BRepMesh import BRepMesh_IncrementalMesh',
  '    from OCP.ShapeFix import ShapeFix_Shape',
  '    from OCP.XCAFDoc import XCAFDoc_DocumentTool',
  '    import OCP',
  "    print('PR_HEAL 1'); print('PR_XCAF 1')",
  '    from OCP.STEPControl import STEPControl_Reader',
  '    import importlib.metadata as meta',
  "    version = 'unknown'",
  "    for name in ('cadquery-ocp', 'pythonocc-core'):",
  '        try:',
  '            version = meta.version(name)',
  '            break',
  '        except Exception:',
  '            pass',
  "    print('PR_OCCT %s' % version)",
  'except Exception as error:',
  "    print('PR_OCCT_MISSING %s' % error)",
  '    sys.exit(1)',
].join('\n');

const REPAIR_KINDS = [
  'sewed_shell',
  'fixed_orientation',
  'dropped_free_edge',
  'removed_degenerate',
  'other',
] as const;
const isRepairKind = (kind: string): kind is (typeof REPAIR_KINDS)[number] =>
  (REPAIR_KINDS as readonly string[]).includes(kind);

/**
 * The sidecar's parts, in the contract's shape.
 *
 * A part whose bounding box came back null keeps a degenerate one rather than being dropped: the
 * indices in `parentIndex` and in every mesh's part list are positions in this array, and removing
 * an entry would silently repoint all of them. The validator refuses it, which is the right outcome
 * — loudly wrong beats quietly renumbered.
 */
function parts(reported: SidecarResult): CadPart[] {
  return reported.parts.map((part) => ({
    name: part.name,
    parentIndex: part.parentIndex,
    bboxMm: part.bboxMm
      ? vec3Pair(part.bboxMm)
      : ([
          [0, 0, 0],
          [0, 0, 0],
        ] as const),
    triangles: part.triangles,
    volumeMm3: part.volumeMm3,
    watertight: part.watertight,
  }));
}

const vec3 = (values: readonly number[]): Vec3Mm => [
  values[0] ?? 0,
  values[1] ?? 0,
  values[2] ?? 0,
];
const vec3Pair = (pair: readonly (readonly number[])[]): readonly [Vec3Mm, Vec3Mm] => [
  vec3(pair[0] ?? []),
  vec3(pair[1] ?? []),
];

const elapsed = (from: number): number => (Date.now() - from) / 1000;

interface RunOutcome {
  code: number | null;
  out: string;
  tail: string[];
  canceled: boolean;
  timedOut: boolean;
  spawnFailed: boolean;
}

function run(
  command: string,
  args: string[],
  timeoutSec: number,
  hooks: {
    env?: Record<string, string>;
    threads?: number;
    onProgress?: (stage: CadStage, fraction: number) => void;
    shouldCancel?: () => Promise<boolean> | boolean;
  } = {},
): Promise<RunOutcome> {
  return new Promise((settle) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // An allow-list, not the supervisor's environment. `...process.env` here would hand
      // DATABASE_URL to the process whose whole job is reading a stranger's file.
      env: sandboxEnv(process.env, {
        ...hooks.env,
        // OCCT's parallel meshing takes every core it is given, which is right on a dedicated
        // ingestion box and wrong on one that is also serving requests.
        ...(hooks.threads ? { OMP_NUM_THREADS: String(hooks.threads) } : {}),
        PYTHONHASHSEED: '0',
      }),
    });

    const tail: string[] = [];
    let out = '';
    let buffer = '';
    let settled = false;
    let canceled = false;
    let timedOut = false;

    const finish = (result: Omit<RunOutcome, 'tail' | 'out'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      settle({ ...result, out, tail: tail.slice(-TAIL_LINES) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);

    const cancelPoll = setInterval(() => {
      void (async () => {
        if (!hooks.shouldCancel) return;
        if (await hooks.shouldCancel()) {
          canceled = true;
          child.kill('SIGKILL');
        }
      })();
    }, CANCEL_POLL_MS);

    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const match = PROGRESS.exec(line.trim());
        if (match) {
          hooks.onProgress?.(match[1] as CadStage, Number(match[2]));
          continue;
        }
        // OCCT narrates its own transfers on stdout. That is not progress and not an error; it is
        // kept as the tail so a puzzling import has something to look at, and otherwise ignored.
        tail.push(line);
        if (tail.length > TAIL_LINES * 4) tail.splice(0, tail.length - TAIL_LINES * 4);
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    child.on('error', () => finish({ code: null, canceled, timedOut, spawnFailed: true }));
    child.on('close', (code) => finish({ code, canceled, timedOut, spawnFailed: false }));
  });
}
