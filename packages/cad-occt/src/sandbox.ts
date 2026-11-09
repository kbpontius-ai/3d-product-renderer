import { spawn } from 'node:child_process';

/**
 * Confining the parser (docs/23-cad-ingestion.md, "Security").
 *
 * OCCT is a large native C++ library written for a trusted engineering context, and this pipeline
 * feeds it files from outside. The design assumption is that the parser will be exploited, because
 * the cheapest assumption is that it already has been — so the interesting question is not whether
 * it can be broken but what an attacker reaches when it is.
 *
 * The answer this file gives: a process with no network, no view of any other process, its own IPC
 * and hostname, a hard ceiling on memory and CPU, and a scratch directory that is deleted when the
 * job ends. Not a filtered egress — none. The pipeline needs nothing from the internet, so a
 * successful exploit finds nothing to call home with, which docs/23 calls the single highest-value
 * control here.
 *
 * This is the in-process half. The container is the other half and neither replaces the other: the
 * container is what an operator configures and can therefore misconfigure, and this is what holds
 * whether they did or not.
 */

/** The confinement that is actually applied. Reported, so a deployment cannot quietly lose it. */
export type SandboxMode = 'namespace' | 'none';

/**
 * What to do when the kernel will not give us a sandbox.
 *
 * `require` refuses to run at all, and is what the container image sets. `prefer` warns and
 * continues, which is right on a developer's machine where the alternative is that nobody can run
 * the importer. `off` is an explicit decision somebody has to write down.
 */
export type SandboxPolicy = 'require' | 'prefer' | 'off';

export const DEFAULT_POLICY: SandboxPolicy = 'prefer';

export function sandboxPolicy(value = process.env['CAD_SANDBOX']): SandboxPolicy {
  return value === 'require' || value === 'prefer' || value === 'off' ? value : DEFAULT_POLICY;
}

export interface SandboxLimits {
  /** Address space ceiling. A malformed shape can ask for everything; this is where it stops. */
  memoryMb: number;
  /**
   * CPU seconds before the kernel sends SIGXCPU.
   *
   * A backstop under the supervisor's wall clock, and a different question: wall clock catches a
   * process that is stuck, this catches one that is busy. Tessellation can spin without any exploit
   * being involved.
   */
  cpuSeconds: number;
  /** Largest file the parser may write, so a runaway mesh fills a limit rather than a disk. */
  maxOutputMb: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  // Comfortably above what a closure needs and well under the `standard` worker class's 8 GB, so
  // the limit bites before the container's does and the failure says which one it was.
  memoryMb: 2048,
  cpuSeconds: 600,
  maxOutputMb: 512,
};

/**
 * `unshare`, and why each flag is here.
 *
 * `--user --map-root-user` is what lets an unprivileged worker do any of this: it makes a user
 * namespace where we are root, which is the prerequisite for the rest. Being root in there confers
 * nothing outside it.
 *
 * `--net` is the one that matters: an empty network namespace, with no interface but a down `lo`.
 *
 * `--pid --fork --mount --mount-proc` hides every other process on the machine, so an exploit
 * cannot see, signal or read `/proc` of anything else — including the supervisor holding the
 * database credentials. All four are needed together, and this is worth being precise about because
 * getting it wrong looks exactly like getting it right: `--pid` alone gives a new PID namespace but
 * leaves the *host's* `/proc` mounted, so the confined process still reads every process on the
 * box. It took a test counting them to notice. `--mount-proc` is what makes the namespace real, and
 * it needs `--mount` to have somewhere private to do it.
 *
 * `--kill-child` is not hardening but correctness, and it is load-bearing: with `--pid`, the thing
 * we spawn is `unshare`, not the parser. Killing `unshare` on a timeout or a cancellation would
 * otherwise leave the parser running with nobody waiting for it.
 *
 * `--ipc --uts` are cheap and remove two more shared namespaces for no cost.
 */
const UNSHARE_ARGS = [
  '--user',
  '--map-root-user',
  '--net',
  '--ipc',
  '--uts',
  '--pid',
  '--mount',
  '--fork',
  '--kill-child',
  '--mount-proc',
] as const;

/**
 * `prlimit`, which applies the ceilings from outside rather than asking the parser to apply them to
 * itself.
 *
 * The parser does set its own limits as well, first thing, before it loads a kernel — but a limit a
 * process applies to itself is only as good as the process reaching that line. Applied here they
 * are in force at `exec`, which is before any of the parser's code runs at all.
 */
export const PRLIMIT = process.env['CAD_PRLIMIT'] ?? 'prlimit';

const prlimitArgs = (limits: SandboxLimits): string[] => [
  `--as=${limits.memoryMb * 1024 * 1024}`,
  `--cpu=${limits.cpuSeconds}`,
  `--fsize=${limits.maxOutputMb * 1024 * 1024}`,
  '--core=0',
];

export const UNSHARE = process.env['CAD_UNSHARE'] ?? 'unshare';

/**
 * The only environment variables the parser is given.
 *
 * Everything else is dropped, `DATABASE_URL` most of all. The supervisor holds credentials for the
 * database and object storage, and `spawn` inheriting `process.env` handed every one of them to the
 * process whose entire job is reading a stranger's file. The namespace takes away the parser's
 * ability to *use* a credential; this takes away its ability to read one.
 *
 * An allow-list rather than a deny-list, because the interesting failure is the variable nobody
 * thought of — the next secret added to the worker's environment should not silently become
 * readable here.
 */
const PASSED_THROUGH = [
  // Where to find the interpreter and its libraries. Without these the parser does not start.
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'PYTHONPATH',
  'PYTHONHOME',
  'LD_LIBRARY_PATH',
  // OCCT's parallel meshing honours these, and the supervisor sets them per job.
  'OMP_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  // A determinism precaution: hash randomisation changes dict iteration order in ways that could
  // reach the output, and two runs of the same file must produce the same bytes.
  'PYTHONHASHSEED',
  // Temp lives on the scratch tmpfs, not wherever the supervisor's happens to be.
  'TMPDIR',
] as const;

/** The parser's whole environment: the allow-list, plus what the sandbox itself sets. */
export function sandboxEnv(
  parent: NodeJS.ProcessEnv,
  own: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...own };
}

export interface SandboxCommand {
  command: string;
  argv: string[];
  /** Applied by the parser to itself, before it loads a kernel or reads a byte of the file. */
  env: Record<string, string>;
  mode: SandboxMode;
}

/**
 * Wraps a command so it runs confined, or reports that it could not be.
 *
 * The limits go through the environment rather than the namespace because they have to be applied
 * *inside* the parser — after the interpreter starts and before it imports OCCT, which is the only
 * moment both possible and early enough to matter.
 */
export function sandboxCommand(
  command: string,
  argv: readonly string[],
  options: { mode: SandboxMode; limits?: Partial<SandboxLimits> },
): SandboxCommand {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const env = {
    PR_CAD_MEMORY_MB: String(limits.memoryMb),
    PR_CAD_CPU_SECONDS: String(limits.cpuSeconds),
    PR_CAD_MAX_OUTPUT_MB: String(limits.maxOutputMb),
    PR_CAD_SANDBOX: options.mode,
  };

  if (options.mode === 'none') return { command, argv: [...argv], env, mode: 'none' };
  return {
    command: UNSHARE,
    argv: [...UNSHARE_ARGS, PRLIMIT, ...prlimitArgs(limits), command, ...argv],
    env,
    mode: 'namespace',
  };
}

export interface SandboxProbe {
  available: boolean;
  mode: SandboxMode;
  reason?: string;
}

/**
 * Whether this kernel will actually give us the namespaces.
 *
 * Asked rather than assumed, and asked by trying: unprivileged user namespaces are a build option
 * and a sysctl, containers disable them, and hardened hosts turn them off. A worker that believed
 * it was sandboxed and was not would be the worst of the available outcomes.
 */
export async function probeSandbox(): Promise<SandboxProbe> {
  const attempt = await new Promise<{ code: number | null; err: string }>((settle) => {
    // Probes the whole chain, not just `unshare`: a host with namespaces but no `prlimit` would
    // otherwise pass here and fail on the first real job.
    const child = spawn(UNSHARE, [...UNSHARE_ARGS, PRLIMIT, ...prlimitArgs(DEFAULT_LIMITS), 'true'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', () => settle({ code: null, err: `${UNSHARE} is not installed` }));
    child.on('close', (code) => settle({ code, err }));
  });

  if (attempt.code === 0) return { available: true, mode: 'namespace' };
  return {
    available: false,
    mode: 'none',
    reason: attempt.err.trim() || 'this kernel refused an unprivileged user namespace',
  };
}

/**
 * The mode to run in, given the policy and what the kernel will allow.
 *
 * Throws under `require`, because the alternative is a worker that reports itself healthy while
 * parsing hostile input unconfined — and a deployment that meant `require` would never find out.
 */
export async function resolveSandbox(policy: SandboxPolicy): Promise<{ mode: SandboxMode; warning?: string }> {
  if (policy === 'off') return { mode: 'none', warning: 'CAD_SANDBOX=off: the parser runs unconfined' };

  const probe = await probeSandbox();
  if (probe.available) return { mode: 'namespace' };

  if (policy === 'require') {
    throw new Error(
      `CAD_SANDBOX=require but this host will not provide a sandbox: ${probe.reason ?? 'unavailable'}`,
    );
  }
  return { mode: 'none', warning: `no sandbox available (${probe.reason ?? 'unavailable'}); parsing unconfined` };
}
