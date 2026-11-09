/**
 * The CAD ingestion queue: submitting a supplier's file, and the worker side that consumes it.
 *
 * The render queue's twin, sharing its lease machinery through `@pr/job-queue` rather than through
 * a copy of it.
 */
export * from './queue.js';
