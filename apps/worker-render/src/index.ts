import { hostname } from 'node:os';
import { connect, serviceEventRecorder, sqlServiceEventStore } from '@pr/db';
import { cyclesLocal } from '@pr/blender';
import { fakeBackend } from '@pr/render-backend';
import { claimJob, sweepStaleJobs } from '@pr/render-jobs';
import { WORKER_HEARTBEAT_SEC, jobLogWriter, keepWorkerAlive, registerWorker } from '@pr/job-queue';
import { mailerFromEnv } from '@pr/mail';
import { defaultStorageRoot, localStorage } from '@pr/storage';
import { increment, log, setErrorReporter, snapshot } from '@pr/observability';
import { runJob } from './job.js';

/**
 * The render worker.
 *
 *   DATABASE_URL=... pnpm --filter @pr/worker-render start
 *
 * One process, one job at a time, claiming from Postgres. Scaling out means running more of these:
 * the queue hands each job to exactly one of them, and a lease means a worker that dies takes only
 * a delay with it. Stopping is safe at any moment — the job it was running goes back to the queue
 * when its lease lapses.
 */

const POLL_IDLE_MS = 2000;
const SWEEP_EVERY_MS = 30_000;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  // Which renderer this worker drives. Cycles on this machine is the default; RENDER_BACKEND=fake
  // swaps in the stand-in, which is how the queue and the download path are exercised on a machine
  // with no renderer. Everything below this line knows only the contract (F-GEN-04).
  const backend =
    process.env['RENDER_BACKEND'] === 'fake'
      ? fakeBackend()
      : cyclesLocal({ ...(process.env['BLENDER_PATH'] ? { blenderPath: process.env['BLENDER_PATH'] } : {}) });

  const probe = await backend.probe();
  if (!probe.available) {
    // Refusing to start is the honest failure. A worker that claims jobs it cannot render would
    // burn every attempt and mark real work as failed.
    log.error(probe.reason ?? 'no usable renderer');
    process.exitCode = 1;
    return;
  }

  const workerId = `${hostname()}-${process.pid}`;
  const sql = connect({ url });
  const storage = localStorage(defaultStorageRoot());
  // Built once rather than per job. `JobDeps.mailer` was optional and never set, so every render
  // notification fell through to the mailer that only logs — the bell worked and the email that
  // F-REND-08 promises never existed.
  const mailer = mailerFromEnv(process.env);
  const scratchRoot = process.env['RENDER_SCRATCH'] ?? '.tmp/render-work';
  const threads = Number(process.env['RENDER_THREADS'] ?? 0) || undefined;

  // Warnings and errors go to the service event log as well as stdout, so the status page shows a
  // worker's problems without anyone reading its terminal.
  const events = serviceEventRecorder('worker-render', sqlServiceEventStore(sql));
  setErrorReporter(events.report);

  // Registered and reporting in whether or not it has work, so idle and dead no longer look alike.
  let currentJob: string | null = null;
  await registerWorker(sql, {
    id: workerId,
    kind: 'render',
    host: hostname(),
    pid: process.pid,
    engine: backend.id,
    ...(probe.version ? { engineVersion: probe.version } : {}),
  });
  const registry = keepWorkerAlive(sql, workerId, () => currentJob, WORKER_HEARTBEAT_SEC);

  const workerLog = log.child({ workerId });
  workerLog.info('render worker ready', {
    backend: backend.id,
    version: probe.version ?? 'unknown',
    features: probe.features,
    threads: threads ?? 'all',
  });

  let running = true;
  let lastSweep = 0;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      workerLog.info('stopping after the current job', { signal, metrics: snapshot() });
      running = false;
    });
  }

  try {
    while (running) {
      if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = Date.now();
        const swept = await sweepStaleJobs(sql);
        if (swept.requeued || swept.failed) {
          // Someone else's job outlived its lease: worth a line, because a worker that keeps
          // abandoning work is a worker that is dying quietly.
          workerLog.warn('swept stale jobs', { requeued: swept.requeued, failed: swept.failed });
        }
      }

      const claim = await claimJob(sql, workerId);
      if (!claim) {
        await sleep(POLL_IDLE_MS);
        continue;
      }

      const started = Date.now();
      currentJob = claim.jobId;
      // The job keeps its own copy of what was logged about it, for the queue page (F-ADM-07).
      const jobLogs = jobLogWriter(sql, 'render_jobs', claim.jobId);
      const jobLog = workerLog
        .child({
          jobId: claim.jobId,
          orgId: claim.orgId,
          attempt: claim.attempts,
          // The request that submitted it: one id ties the click, the queue row and the render.
          ...(claim.traceId ? { requestId: claim.traceId } : {}),
        })
        .tee((record) => jobLogs.record(record));
      jobLog.info('job claimed');
      let lastStage: string | null = null;
      increment('render.claimed');

      const outcome = await runJob(claim, {
        log: jobLog,
        backend,
        ...(process.env['APP_URL'] ? { appUrl: process.env['APP_URL'] } : {}),
        mailer,
        sql,
        storage,
        workerId,
        scratchRoot,
        ...(threads ? { threads } : {}),
        onProgress: (stage, fraction) => {
          if (stage !== lastStage) {
            lastStage = stage;
            jobLog.info('stage', { stage });
          }
          jobLog.debug('progress', { stage, fraction: Number(fraction.toFixed(3)) });
        },
      });

      jobLog.info('job done', { outcome, ms: Date.now() - started });
      await jobLogs.close();
      currentJob = null;
    }
  } finally {
    await registry.stop();
    setErrorReporter(null);
    await events.stop();
    await sql.end();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

void main().catch((error: unknown) => {
  log.error('render worker stopped', error);
  process.exitCode = 1;
});
