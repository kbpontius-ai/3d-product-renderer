import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SceneJob } from './scene.js';

/**
 * Invoking Blender (docs/17 §"Supervisor loop").
 *
 * `--factory-startup --disable-autoexec` is not a nicety: it is what stops a user's add-ons, a
 * user's preferences and any embedded script from being part of a render. Blender is handed a
 * generated script and a JSON file, and nothing else.
 */

export interface RunOptions {
  blenderPath?: string;
  scratchDir: string;
  timeoutSec: number;
  /**
   * Rendering threads. Absent means every core.
   *
   * A path tracer will take the whole machine if allowed to, which is right on a dedicated render
   * box and wrong on one that is also serving requests.
   */
  threads?: number;
  onProgress?: (stage: string, fraction: number) => void;
  /** Polled every couple of seconds; returning true kills the process. */
  shouldCancel?: () => Promise<boolean> | boolean;
}

export type RunFailure =
  | 'timeout'
  | 'canceled'
  | 'renderer_crash'
  | 'renderer_unavailable'
  | 'oom';

export interface RunResult {
  status: 'ok' | 'failed';
  failure?: RunFailure;
  message?: string;
  seconds: number;
  /** Last few lines of Blender's output, for the job's error record. */
  tail: string[];
}

const PROGRESS = /^PR_PROGRESS (\S+) ([\d.]+)$/;
const CANCEL_POLL_MS = 2000;
const TAIL_LINES = 25;

export const DEFAULT_BLENDER = process.env['BLENDER_PATH'] ?? 'blender';

/** Whether a usable Blender exists, and what it can do — builds differ in ways that matter. */
export async function probeBlender(
  blenderPath = DEFAULT_BLENDER,
): Promise<{ available: boolean; version?: string; denoiser: boolean }> {
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(blenderPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', () => resolve({ code: null, out: '' }));
    child.on('close', (code) => resolve({ code, out }));
  });

  if (result.code !== 0) return { available: false, denoiser: false };

  const version = /Blender\s+(\S+)/.exec(result.out)?.[1];
  return {
    available: true,
    ...(version ? { version } : {}),
    // Distribution builds are routinely compiled without OpenImageDenoise. Asking for it anyway
    // fails the render at the last moment, so it is probed once and switched off for the job.
    denoiser: await hasDenoiser(blenderPath),
  };
}

async function hasDenoiser(blenderPath: string): Promise<boolean> {
  const script = [
    'import bpy',
    "print('PR_DENOISER', 'OPENIMAGEDENOISE' in {i.identifier for i in bpy.types.Scene.bl_rna.properties['cycles'].fixed_type.properties['denoiser'].enum_items})",
  ].join('\n');

  return new Promise((resolve) => {
    const child = spawn(
      blenderPath,
      ['--background', '--factory-startup', '--disable-autoexec', '--python-expr', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(/PR_DENOISER True/.test(out)));
  });
}

export async function runScene(job: SceneJob, options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const blenderPath = options.blenderPath ?? DEFAULT_BLENDER;

  const scratchDir = resolve(options.scratchDir);
  await mkdir(scratchDir, { recursive: true });
  const scriptPath = join(scratchDir, 'scene.py');
  const dataPath = join(scratchDir, 'scene.json');
  await writeFile(scriptPath, job.script, 'utf8');
  await writeFile(dataPath, JSON.stringify(job.data), 'utf8');

  try {
    await access(job.data.meshPath);
  } catch {
    return {
      status: 'failed',
      failure: 'renderer_crash',
      message: `mesh not found: ${job.data.meshPath}`,
      seconds: 0,
      tail: [],
    };
  }

  // Asked before the process is launched, not only while it runs. A job cancelled between being
  // claimed and being started would otherwise cost a full render nobody is waiting for — and the
  // poll below only fires every couple of seconds, which a small render can finish inside.
  if (options.shouldCancel && (await options.shouldCancel())) {
    return { status: 'failed', failure: 'canceled', message: 'canceled', seconds: 0, tail: [] };
  }

  return new Promise<RunResult>((resolve) => {
    const child = spawn(
      blenderPath,
      [
        '--background',
        '--factory-startup',
        '--disable-autoexec',
        '--python-exit-code',
        '1',
        ...(options.threads ? ['-t', String(options.threads)] : []),
        '--python',
        scriptPath,
        '--',
        dataPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: scratchDir },
    );

    const tail: string[] = [];
    let settled = false;
    let canceled = false;
    let timedOut = false;
    let buffer = '';

    const finish = (result: Omit<RunResult, 'seconds' | 'tail'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      resolve({ ...result, seconds: (Date.now() - started) / 1000, tail: tail.slice(-TAIL_LINES) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutSec * 1000);

    const cancelPoll = setInterval(() => {
      void (async () => {
        if (!options.shouldCancel) return;
        if (await options.shouldCancel()) {
          canceled = true;
          child.kill('SIGKILL');
        }
      })();
    }, CANCEL_POLL_MS);

    const consume = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        tail.push(line);
        if (tail.length > TAIL_LINES * 4) tail.splice(0, tail.length - TAIL_LINES * 4);
        const match = PROGRESS.exec(line.trim());
        if (match) options.onProgress?.(match[1]!, Number(match[2]));
      }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    child.on('error', () =>
      finish({
        status: 'failed',
        failure: 'renderer_unavailable',
        message: `could not start ${blenderPath}`,
      }),
    );

    child.on('close', (code, signal) => {
      if (canceled) return finish({ status: 'failed', failure: 'canceled', message: 'Canceled.' });
      if (timedOut) {
        return finish({
          status: 'failed',
          failure: 'timeout',
          message: `Render exceeded ${options.timeoutSec}s.`,
        });
      }
      if (code === 0) return finish({ status: 'ok' });

      const output = tail.join('\n');
      const failure: RunFailure = /out of memory|bad_alloc|Cannot allocate/i.test(output)
        ? 'oom'
        : 'renderer_crash';
      finish({
        status: 'failed',
        failure,
        message: signal ? `Blender was killed (${signal}).` : `Blender exited with code ${code}.`,
      });
    });
  });
}
