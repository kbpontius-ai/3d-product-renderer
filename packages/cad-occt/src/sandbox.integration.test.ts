import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, probeSandbox, resolveSandbox, sandboxCommand, sandboxEnv } from './sandbox.js';

/**
 * That the confinement is real (docs/23-cad-ingestion.md, "Security").
 *
 * A sandbox nobody tested is a comment. Each of these runs a real process under the real wrapper
 * and checks it cannot do the thing it is not supposed to be able to do — because the failure mode
 * that matters is not "the sandbox broke", it is "the sandbox was never applied and everything
 * looked fine".
 */

const probe = await probeSandbox();
const unconfined = !probe.available;

if (unconfined) {
  console.warn(`skipping the sandbox suite: ${probe.reason ?? 'no namespaces on this host'}`);
}

/** Runs a snippet of Python under whatever `sandboxCommand` produces, and returns what happened. */
async function runPython(
  source: string,
  mode: 'namespace' | 'none',
  limits?: Partial<typeof DEFAULT_LIMITS>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  const python = process.env['CAD_PYTHON'] ?? 'python3';
  const confined = sandboxCommand(python, ['-c', source], { mode, ...(limits ? { limits } : {}) });

  return new Promise((settle) => {
    const child = spawn(confined.command, confined.argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...confined.env },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code, signal) => settle({ code, signal, out }));
  });
}

const REACH_OUT = `
import socket
socket.setdefaulttimeout(4)
try:
    socket.create_connection(('1.1.1.1', 443))
    print('REACHED')
except Exception as error:
    print('REFUSED', type(error).__name__)
`;

if (process.env['CI'] && unconfined) {
  throw new Error(`Required integration-test dependency is unavailable: ${probe.reason ?? 'probe failed'}`);
}

describe.skipIf(unconfined)('the parser sandbox', () => {
  it('has no network at all', async () => {
    // The single highest-value control here. Not a filtered egress — none: the pipeline needs
    // nothing from the internet, so a successful exploit finds no way to call home.
    const confined = await runPython(REACH_OUT, 'namespace');
    expect(confined.out).toContain('REFUSED');
    expect(confined.out).not.toContain('REACHED');
  }, 60_000);

  it('proves that check can fail, by running the same code unconfined', async () => {
    // Without this the test above passes on a machine with no internet, and would keep passing if
    // the sandbox silently stopped being applied. This is what makes it evidence.
    const open = await runPython(REACH_OUT, 'none');
    expect(open.out).toMatch(/REACHED|REFUSED/);
    if (open.out.includes('REFUSED')) {
      console.warn('this host has no outbound network; the no-network test proves less than usual');
    }
  }, 60_000);

  it('cannot see any other process on the machine', async () => {
    // Including the supervisor, which holds the database credentials.
    const confined = await runPython(
      "import os; print('PIDS', len([p for p in os.listdir('/proc') if p.isdigit()]))",
      'namespace',
    );
    const count = Number(/PIDS (\d+)/.exec(confined.out)?.[1] ?? -1);
    expect(count).toBeGreaterThan(0);
    // Itself, and `unshare`'s fork. A host's worth of processes would mean the PID namespace is
    // there but `/proc` is still the host's — which is what this caught the first time.
    expect(count).toBeLessThanOrEqual(3);
  }, 60_000);

  it('stops a process that tries to take all the memory', async () => {
    const confined = await runPython(
      "block = bytearray(400 * 1024 * 1024)\nprint('ALLOCATED', len(block))",
      'namespace',
      { memoryMb: 128 },
    );
    expect(confined.out).not.toContain('ALLOCATED');
    expect(confined.out).toMatch(/MemoryError|Killed|Cannot allocate/i);
  }, 60_000);

  it('stops a process that spins, even when it ignores every signal it can', async () => {
    // RLIMIT_CPU is the backstop under the supervisor's wall clock: this catches a job that is busy
    // rather than stuck, which is what a tessellation on a degenerate face looks like. SIGXCPU is
    // handled here to show the kernel's SIGKILL follows anyway.
    const spin = `
import signal
signal.signal(signal.SIGXCPU, signal.SIG_IGN)
print('SPINNING', flush=True)
while True:
    pass
`;
    const started = Date.now();
    const confined = await runPython(spin, 'namespace', { cpuSeconds: 2 });

    expect(confined.out).toContain('SPINNING');
    // Non-zero, not a signal: the process we spawn is `unshare`, and the kernel's SIGKILL lands on
    // the parser inside it. `unshare` reports that as a failed exit, which is the only thing a
    // supervisor could see either.
    expect(confined.code).not.toBe(0);
    // And it stopped because of the ceiling rather than because the test gave up on it.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('refuses to write a file bigger than it is allowed', async () => {
    const confined = await runPython(
      "open('/tmp/pr-cad-limit-probe', 'wb').write(b'x' * (4 * 1024 * 1024))\nprint('WROTE')",
      'namespace',
      { maxOutputMb: 1 },
    );
    expect(confined.out).not.toContain('WROTE');
    await rm('/tmp/pr-cad-limit-probe', { force: true });
  }, 60_000);

  it('still lets the parser do its actual job', async () => {
    // Every limit above is worthless if it also stops a legitimate import, and a sandbox that broke
    // the happy path would be discovered by a customer rather than by this file.
    const root = await mkdtemp(join(tmpdir(), 'pr-sandbox-'));
    try {
      const requestPath = join(root, 'request.json');
      const resultPath = join(root, 'result.json');
      await writeFile(
        requestPath,
        JSON.stringify({
          sourcePath: 'fixtures/cad/closure-38.step',
          scratchDir: root,
          resultPath,
          limits: { maxShapes: 2000, maxAssemblyDepth: 16, maxTrianglesTotal: 8_000_000 },
          lods: [{ name: 'lod0', deflectionMm: 0.08, angularDeg: 25, maxTriangles: 40_000 }],
        }),
      );

      const script = new URL('./occt_import.py', import.meta.url).pathname;
      const python = process.env['CAD_PYTHON'] ?? 'python3';
      const confined = sandboxCommand(python, [script, requestPath], { mode: 'namespace' });

      const code = await new Promise<number | null>((settle) => {
        const child = spawn(confined.command, confined.argv, {
          stdio: 'ignore',
          env: { ...process.env, ...confined.env },
        });
        child.on('close', settle);
      });

      expect(code).toBe(0);
      const result = JSON.parse(await readFile(resultPath, 'utf8')) as { status: string };
      expect(result.status).toBe('ok');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('the parser environment', () => {
  it('does not carry the supervisor\'s secrets', () => {
    // The namespace takes away the parser's ability to *use* a credential. This takes away its
    // ability to read one — which matters because `spawn` inheriting process.env handed
    // DATABASE_URL to the process whose whole job is reading a stranger's file.
    const env = sandboxEnv(
      {
        PATH: '/usr/bin',
        DATABASE_URL: 'postgres://user:hunter2@db/app',
        ASSET_URL_SECRET: 'signing-key',
        AWS_SECRET_ACCESS_KEY: 'storage-key',
        SMTP_PASSWORD: 'mail',
      },
      {},
    );

    expect(env['PATH']).toBe('/usr/bin');
    expect(Object.keys(env)).toEqual(['PATH']);
    expect(JSON.stringify(env)).not.toContain('hunter2');
  });

  it('is an allow-list, so a secret added later is not inherited by accident', () => {
    // The interesting failure is the variable nobody thought of. A deny-list would have to be
    // updated every time the worker gains a credential; this one does not.
    const env = sandboxEnv({ PATH: '/usr/bin', SOME_FUTURE_TOKEN: 'nope' }, {});
    expect(env['SOME_FUTURE_TOKEN']).toBeUndefined();
  });

  it('still passes what the parser needs to start and to stay deterministic', () => {
    const env = sandboxEnv(
      { PATH: '/usr/bin', HOME: '/home/x', LD_LIBRARY_PATH: '/opt/occt/lib', DATABASE_URL: 'secret' },
      { PYTHONHASHSEED: '0', OMP_NUM_THREADS: '2' },
    );

    expect(env['LD_LIBRARY_PATH']).toBe('/opt/occt/lib');
    expect(env['PYTHONHASHSEED']).toBe('0');
    expect(env['OMP_NUM_THREADS']).toBe('2');
    expect(env['DATABASE_URL']).toBeUndefined();
  });
});

describe('sandbox policy', () => {
  it('refuses to run unconfined when the deployment said require', async () => {
    // The container image sets this. A worker that reported itself healthy while parsing hostile
    // input unconfined is the one outcome worse than not starting.
    if (probe.available) {
      await expect(resolveSandbox('require')).resolves.toMatchObject({ mode: 'namespace' });
    } else {
      await expect(resolveSandbox('require')).rejects.toThrow(/will not provide a sandbox/);
    }
  }, 60_000);

  it('says so out loud when it falls back, rather than continuing quietly', async () => {
    const resolved = await resolveSandbox('off');
    expect(resolved.mode).toBe('none');
    expect(resolved.warning).toMatch(/unconfined/);
  });

  it('puts the limits where the parser will read them', () => {
    const confined = sandboxCommand('python3', ['x.py'], { mode: 'namespace', limits: { memoryMb: 64 } });

    expect(confined.env['PR_CAD_MEMORY_MB']).toBe('64');
    expect(confined.env['PR_CAD_CPU_SECONDS']).toBe(String(DEFAULT_LIMITS.cpuSeconds));
    expect(confined.argv).toContain('--net');
    // `--kill-child` is correctness rather than hardening: with `--pid`, the process we spawn is
    // `unshare`, and killing it on a timeout would otherwise orphan the parser.
    expect(confined.argv).toContain('--kill-child');
    expect(confined.argv.at(-2)).toBe('python3');
  });

  it('runs the command directly when there is no sandbox, without silently adding one', () => {
    const open = sandboxCommand('python3', ['x.py'], { mode: 'none' });
    expect(open.command).toBe('python3');
    expect(open.argv).toEqual(['x.py']);
    expect(open.env['PR_CAD_SANDBOX']).toBe('none');
  });
});
