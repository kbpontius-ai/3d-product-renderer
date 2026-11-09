import { hostname } from 'node:os';
import { referenceImporter, type CadImporter } from '@pr/cad';
import { occtLocal } from '@pr/cad-occt';
import { claimIngestion, sweepStaleIngestions } from '@pr/cad-jobs';
import { connect, serviceEventRecorder, sqlServiceEventStore } from '@pr/db';
import { WORKER_HEARTBEAT_SEC, jobLogWriter, keepWorkerAlive, registerWorker } from '@pr/job-queue';
import { defaultStorageRoot, localStorage } from '@pr/storage';
import { increment, log, setErrorReporter, snapshot } from '@pr/observability';
import { runIngestion } from './job.js';

/**
 * The CAD ingestion worker.
 *
 *   DATABASE_URL=... pnpm --filter @pr/worker-cad start
 *
 * One process, one file at a time, claiming from Postgres — the render worker's twin, and for the
 * same reasons. What is different is the threat model: this process exists to feed a stranger's
 * file to a large native parser, so in production it runs in its own container with no network at
 * all, a read-only root filesystem and hard memory, CPU and wall-clock caps (docs/23, "Security").
 * None of that is expressed here, because none of it should be: a process cannot be trusted to
 * confine itself.
 */

const POLL_IDLE_MS = 2000;
const SWEEP_EVERY_MS = 30_000;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 600;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const importer = await chooseImporter();
  const probe = await importer.probe();
  if (!probe.available) {
    // Refusing to start is the honest failure. A worker that claims jobs it cannot import would
    // burn every attempt and mark real work as failed.
    log.error(probe.reason ?? 'no usable CAD importer');
    process.exitCode = 1;
    return;
  }

  const workerId = `${hostname()}-${process.pid}`;
  const sql = connect({ url });
  const storage = localStorage(defaultStorageRoot());
  const scratchRoot = process.env['CAD_SCRATCH'] ?? '.tmp/cad-work';
  const threads = Number(process.env['CAD_THREADS'] ?? 0) || undefined;
  const maxSourceBytes = Number(process.env['CAD_MAX_SOURCE_BYTES'] ?? 0) || DEFAULT_MAX_SOURCE_BYTES;
  const timeoutSec = Number(process.env['CAD_TIMEOUT_SEC'] ?? 0) || DEFAULT_TIMEOUT_SEC;

  // Warnings and errors reach the status page's service event log as well as stdout.
  const events = serviceEventRecorder('worker-cad', sqlServiceEventStore(sql));
  setErrorReporter(events.report);

  let currentJob: string | null = null;
  await registerWorker(sql, {
    id: workerId,
    kind: 'cad',
    host: hostname(),
    pid: process.pid,
    engine: importer.id,
    ...(probe.version ? { engineVersion: probe.version } : {}),
  });
  const registry = keepWorkerAlive(sql, workerId, () => currentJob, WORKER_HEARTBEAT_SEC);

  const workerLog = log.child({ workerId });
  // The sandbox is logged at startup, and prominently, because the failure that matters is not a
  // sandbox that breaks — it is one that was never applied while everything looked healthy.
  if (probe.features['sandbox'] === false) {
    workerLog.warn('the CAD parser is running UNCONFINED', {
      detail: probe.reason ?? 'no sandbox on this host',
      remedy: 'set CAD_SANDBOX=require, or run the container image, which does',
    });
  }

  workerLog.info('cad worker ready', {
    importer: importer.id,
    version: probe.version ?? 'unknown',
    formats: importer.formats,
    features: probe.features,
    sandbox: probe.features['sandbox'] === true ? 'namespace' : 'none',
    threads: threads ?? 'all',
    maxSourceBytes,
    timeoutSec,
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
        const swept = await sweepStaleIngestions(sql);
        if (swept.requeued || swept.failed) {
          workerLog.warn('swept stale ingestions', { requeued: swept.requeued, failed: swept.failed });
        }
      }

      // The lease has to outlast a stage, not a job: a heavy assembly spends minutes inside the
      // kernel between heartbeats, and a lease shorter than that would hand the job to a second
      // worker while the first is still holding the file.
      const claim = await claimIngestion(sql, workerId, Math.max(120, Math.ceil(timeoutSec / 4)));
      if (!claim) {
        await sleep(POLL_IDLE_MS);
        continue;
      }

      const started = Date.now();
      currentJob = claim.jobId;
      const jobLogs = jobLogWriter(sql, 'cad_jobs', claim.jobId);
      const jobLog = workerLog
        .child({
          jobId: claim.jobId,
          orgId: claim.orgId,
          attempt: claim.attempts,
          ...(claim.traceId ? { requestId: claim.traceId } : {}),
        })
        .tee((record) => jobLogs.record(record));
      let lastStage: string | null = null;
      jobLog.info('ingestion claimed', {
        format: claim.format,
        profile: claim.profile,
        bytes: claim.sourceBytes,
        // The operator's file name, which is a hint and nothing more — the format came from content.
        name: claim.sourceName,
      });
      increment('cad.claimed');

      const outcome = await runIngestion(claim, {
        log: jobLog,
        importer,
        sql,
        storage,
        workerId,
        scratchRoot,
        maxSourceBytes,
        timeoutSec,
        ...(threads ? { threads } : {}),
        onProgress: (stage, fraction) => {
          if (stage !== lastStage) {
            lastStage = stage;
            jobLog.info('stage', { stage });
          }
          jobLog.debug('progress', { stage, fraction: Number(fraction.toFixed(3)) });
        },
      });

      jobLog.info('ingestion done', { outcome, ms: Date.now() - started });
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

/**
 * Which kernel this worker drives.
 *
 * OCCT when the machine has it, and the reference importer when it does not — which is what makes
 * the queue, the validator and the whole storage path exercisable in CI and on a laptop, exactly as
 * `RENDER_BACKEND=fake` does for rendering. `CAD_IMPORTER` forces one, and forcing `occt` on a
 * machine without it is meant to fail loudly rather than fall back: a deployment that quietly
 * downgraded to the fake importer would publish packs made of parametric cylinders.
 */
async function chooseImporter(): Promise<CadImporter> {
  const requested = process.env['CAD_IMPORTER'];
  if (requested === 'reference') return referenceImporter();

  const occt = occtLocal();
  if (requested === 'occt') return occt;

  const probe = await occt.probe();
  if (probe.available) return occt;

  log.warn('no CAD kernel on this machine; using the reference importer', { reason: probe.reason });
  return referenceImporter();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

void main().catch((error: unknown) => {
  log.error('cad worker stopped', error);
  process.exitCode = 1;
});
