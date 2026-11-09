import 'server-only';
import { withTenant } from '@pr/db';
import { getSql } from './db.js';

/**
 * An organisation's limits, read where a route needs to enforce one.
 *
 * The schema's defaults stand in for a missing row on purpose: a data gap must not read as
 * "unlimited", because that turns into an uncapped bill nobody notices until an invoice.
 */
export interface Quotas {
  rendersPerDay: number;
  maxConcurrentJobs: number;
  maxResolutionPx: number;
}

const DEFAULTS: Quotas = { rendersPerDay: 50, maxConcurrentJobs: 3, maxResolutionPx: 4096 };

export async function orgQuotas(orgId: string): Promise<Quotas> {
  const [row] = await withTenant(getSql(), { orgId, userId: null }, (tx) =>
    tx`select renders_per_day, max_concurrent_jobs, max_resolution_px from org_quotas where org_id = ${orgId}`,
  );

  return row
    ? {
        rendersPerDay: Number(row['renders_per_day']),
        maxConcurrentJobs: Number(row['max_concurrent_jobs']),
        maxResolutionPx: Number(row['max_resolution_px']),
      }
    : DEFAULTS;
}
