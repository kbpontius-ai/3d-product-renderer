/**
 * In-process counters and timings.
 *
 * Not a metrics backend: a small registry the render worker fills in and the admin queue page
 * reads, so "which stage is slow" and "how often does the bake fail" have answers before anyone
 * stands up Prometheus. Everything here is per-process and resets on restart, which is why the
 * numbers that must survive a restart (a job's stage timings) are written to its row instead.
 */

export interface Timing {
  count: number;
  totalMs: number;
  maxMs: number;
}

const counters = new Map<string, number>();
const timings = new Map<string, Timing>();

export function increment(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function observe(name: string, ms: number): void {
  const current = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  timings.set(name, {
    count: current.count + 1,
    totalMs: current.totalMs + ms,
    maxMs: Math.max(current.maxMs, ms),
  });
}

/** Times `fn`, recording it under `name` whether it succeeds or throws. */
export async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    observe(name, Date.now() - started);
  }
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  timings: Record<string, Timing & { meanMs: number }>;
}

export function snapshot(): MetricsSnapshot {
  const out: MetricsSnapshot = { counters: {}, timings: {} };
  for (const [name, value] of counters) out.counters[name] = value;
  for (const [name, timing] of timings) {
    out.timings[name] = { ...timing, meanMs: timing.count ? timing.totalMs / timing.count : 0 };
  }
  return out;
}

export function resetMetrics(): void {
  counters.clear();
  timings.clear();
}
