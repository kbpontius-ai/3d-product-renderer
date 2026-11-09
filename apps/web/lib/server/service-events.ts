import 'server-only';
import { serviceEventRecorder, sqlServiceEventStore } from '@pr/db';
import { setErrorReporter } from '@pr/observability';
import { reportable } from '../system-status';
import { databaseConfigured, getSql } from './db';

const globalForEvents = globalThis as unknown as { __prServiceEvents?: boolean };

/**
 * Sends this process's warnings and errors to the service event log (F-PLAT-02, F-ADM-15).
 *
 * Called once at server start from `instrumentation.ts`. Before it, the logger's reporter seam was
 * never connected: an error went to the terminal and nowhere a person running the platform looks.
 */
export function installServiceEvents(): void {
  if (globalForEvents.__prServiceEvents || !databaseConfigured()) return;
  globalForEvents.__prServiceEvents = true;

  const recorder = serviceEventRecorder('web', sqlServiceEventStore(getSql()));
  setErrorReporter((error, fields, level) => {
    if (reportable(level, fields)) recorder.report(error, fields, level);
  });
}
