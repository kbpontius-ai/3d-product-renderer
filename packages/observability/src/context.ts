import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Logger, log, type Fields } from './logger.js';

/**
 * The ambient logger for whatever is being handled right now.
 *
 * Passing a logger down every call chain is the honest design and an unreasonable amount of
 * plumbing for a field that never changes within a request. `AsyncLocalStorage` keeps the request
 * id attached across awaits, so a query five layers down logs the same id as the route that
 * started it — which is the entire point of having one.
 *
 * The store holds a mutable box rather than the logger itself because some fields are only learned
 * partway through: a request knows its org after the session is validated, not before, and the
 * lines logged after that should say so.
 */

interface Box {
  logger: Logger;
}

const storage = new AsyncLocalStorage<Box>();

export function newRequestId(): string {
  return randomUUID();
}

/** Runs `fn` with `logger` as the ambient logger for everything it awaits. */
export function withLogContext<T>(logger: Logger, fn: () => T): T {
  return storage.run({ logger }, fn);
}

/** The ambient logger, or the process-wide one outside a request. */
export function currentLog(): Logger {
  return storage.getStore()?.logger ?? log;
}

/**
 * Adds fields to the ambient logger for the rest of this request.
 *
 * Called when the request learns who is asking; every later line carries it, including the one the
 * route wrapper writes at the end.
 */
export function enrichLogContext(fields: Fields): void {
  const box = storage.getStore();
  if (box) box.logger = box.logger.child(fields);
}

/**
 * The id the current request is logging under.
 *
 * Read back off the ambient logger rather than threaded through as an argument: it is already
 * there, and a second copy of it would eventually disagree with the one in the log lines.
 */
export function currentRequestId(): string | null {
  const value = currentLog().fields['requestId'];
  return typeof value === 'string' ? value : null;
}
