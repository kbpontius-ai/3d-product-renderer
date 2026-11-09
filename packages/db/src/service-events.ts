import { withStaff, type Sql } from './client.js';

/**
 * Writing warnings and errors to `service_events`, the log the status page shows (F-PLAT-02).
 *
 * Lives with the schema for the reason the audit helper does: the web app and both workers write
 * here, and none of them owns it. It is fed from the logger's reporter seam, so what arrives has
 * already been redacted by the logger.
 *
 * It must never become the problem it is recording. Events are buffered and written in batches off
 * the request path; the buffer is bounded, so an error loop cannot eat memory; a failed write drops
 * the batch and says so once on stderr — never through the logger, which would report the failure
 * back into this recorder.
 */

export type ServiceEventLevel = 'warn' | 'error';

export interface ServiceEvent {
  at: Date;
  service: string;
  level: ServiceEventLevel;
  message: string;
  fields: Record<string, unknown>;
  error: { name: string; message: string; stack?: string } | null;
  requestId: string | null;
  jobId: string | null;
}

export interface ServiceEventStore {
  write(events: ServiceEvent[]): Promise<void>;
  prune(): Promise<void>;
}

export interface RecorderOptions {
  flushMs?: number;
  maxBuffer?: number;
  pruneEveryMs?: number;
  now?: () => Date;
  /** Where a failed write is mentioned. Not the logger, deliberately. */
  complain?: (line: string) => void;
}

/** Two weeks, and never more than this many rows, whichever is smaller. */
const KEEP_DAYS = 14;
const KEEP_ROWS = 20_000;
const STACK_MAX_CHARS = 4000;

export function sqlServiceEventStore(sql: Sql): ServiceEventStore {
  return {
    async write(events) {
      await withStaff(sql, (tx) => tx`
        insert into service_events ${tx(
          events.map((e) => ({
            at: e.at,
            service: e.service,
            level: e.level,
            message: e.message,
            fields: tx.json(e.fields as never),
            error: e.error ? tx.json(e.error as never) : null,
            request_id: e.requestId,
            job_id: e.jobId,
          })) as never,
        )}`);
    },
    async prune() {
      await withStaff(sql, async (tx) => {
        await tx`delete from service_events where at < now() - make_interval(days => ${KEEP_DAYS})`;
        await tx`
          delete from service_events
          where id <= (select id from service_events order by id desc offset ${KEEP_ROWS} limit 1)`;
      });
    },
  };
}

export function serviceEventRecorder(service: string, store: ServiceEventStore, options: RecorderOptions = {}) {
  const flushMs = options.flushMs ?? 2000;
  const maxBuffer = options.maxBuffer ?? 500;
  const pruneEveryMs = options.pruneEveryMs ?? 10 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  const complain = options.complain ?? ((line: string) => process.stderr.write(`${line}\n`));

  let buffer: ServiceEvent[] = [];
  let dropped = 0;
  let lastPrune = 0;
  let failing = false;
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (buffer.length === 0 && dropped === 0) return chain;
    const batch = buffer;
    if (dropped > 0) {
      batch.push(event(now(), 'warn', `dropped ${dropped} events: they arrived faster than they could be written`, {}));
      dropped = 0;
    }
    buffer = [];

    chain = chain
      .then(async () => {
        await store.write(batch);
        if (now().getTime() - lastPrune > pruneEveryMs) {
          lastPrune = now().getTime();
          await store.prune();
        }
        failing = false;
      })
      .catch((error: unknown) => {
        if (!failing) complain(`service events: could not record ${batch.length}: ${String(error)}`);
        failing = true;
      });
    return chain;
  };

  const timer = setInterval(() => void flush(), flushMs);
  timer.unref?.();

  function event(
    at: Date,
    level: ServiceEventLevel,
    message: string,
    fields: Record<string, unknown>,
    error?: unknown,
  ): ServiceEvent {
    const { requestId, jobId, ...rest } = fields;
    return {
      at,
      service,
      level,
      message,
      fields: rest,
      error: flatten(error),
      requestId: typeof requestId === 'string' ? requestId : null,
      jobId: typeof jobId === 'string' ? jobId : null,
    };
  }

  return {
    /** Shaped to be the logger's reporter: `setErrorReporter(recorder.report)`. */
    report: (error: unknown, fields: Record<string, unknown>, level: ServiceEventLevel): void => {
      const { message, ...rest } = fields;
      if (buffer.length >= maxBuffer) {
        dropped += 1;
        return;
      }
      buffer.push(event(now(), level, typeof message === 'string' ? message : 'unlabelled', rest, error));
    },
    flush,
    async stop(): Promise<void> {
      clearInterval(timer);
      await flush();
    },
  };
}

function flatten(error: unknown): ServiceEvent['error'] {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack.slice(0, STACK_MAX_CHARS) } : {}),
    };
  }
  return { name: 'NonError', message: String(error) };
}
