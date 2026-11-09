import { recordAudit, type Sql, withStaff } from '@pr/db';
import { AdminError } from './errors.js';

/**
 * Organisations and their limits (F-ADM-06).
 *
 * The numbers here are the only thing standing between one customer and the whole render farm, so
 * they are stored per organisation rather than inferred, and every change is attributed.
 */

export interface Quotas {
  rendersPerDay: number;
  gpuSecondsPerMonth: number;
  storageBytes: number;
  maxConcurrentJobs: number;
  maxResolutionPx: number;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  users: number;
  designs: number;
  rendersToday: number;
  quotas: Quotas;
}

const QUOTA_LIMITS: Record<keyof Quotas, { min: number; max: number }> = {
  rendersPerDay: { min: 0, max: 100_000 },
  gpuSecondsPerMonth: { min: 0, max: 100_000_000 },
  storageBytes: { min: 0, max: 100_000_000_000_000 },
  maxConcurrentJobs: { min: 0, max: 1000 },
  maxResolutionPx: { min: 256, max: 16_384 },
};

export async function listOrganizations(sql: Sql): Promise<OrgSummary[]> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select
        o.id, o.name, o.slug, o.status, o.created_at,
        coalesce(q.renders_per_day, 50) as renders_per_day,
        coalesce(q.gpu_seconds_per_month, 36000) as gpu_seconds_per_month,
        coalesce(q.storage_bytes, 53687091200) as storage_bytes,
        coalesce(q.max_concurrent_jobs, 3) as max_concurrent_jobs,
        coalesce(q.max_resolution_px, 4096) as max_resolution_px,
        (select count(*) from users u where u.org_id = o.id) as user_count,
        (select count(*) from designs d where d.org_id = o.id and d.deleted_at is null) as design_count,
        (select count(*) from render_jobs j
          where j.org_id = o.id and j.queued_at >= date_trunc('day', now())) as renders_today
      from organizations o
      left join org_quotas q on q.org_id = o.id
      order by o.created_at`;

    return rows.map(toSummary);
  });
}

export async function getOrganization(sql: Sql, orgId: string): Promise<OrgSummary> {
  const [org] = await listOrganizations(sql).then((all) => all.filter((o) => o.id === orgId));
  if (!org) throw new AdminError('not_found', 'no such organisation');
  return org;
}

export async function createOrganization(
  sql: Sql,
  input: { name: string; slug: string; actorId: string | null },
): Promise<OrgSummary> {
  const slug = normalizeSlug(input.slug);
  const name = input.name.trim();
  if (!name) throw new AdminError('invalid', 'an organisation needs a name');
  if (!slug) throw new AdminError('invalid', 'an organisation needs a slug');

  const id = crypto.randomUUID();
  await withStaff(sql, async (tx) => {
    const [existing] = await tx`select id from organizations where slug = ${slug}`;
    if (existing) throw new AdminError('conflict', `the slug "${slug}" is taken`);

    await tx`insert into organizations (id, name, slug) values (${id}, ${name}, ${slug})`;
    // Quotas exist from the first moment: an organisation without a row would otherwise be
    // governed by whatever the reading code happened to default to.
    await tx`insert into org_quotas (org_id) values (${id})`;
    await recordAudit(tx, {
      orgId: id,
      actorUserId: input.actorId,
      action: 'org.created',
      targetType: 'organization',
      targetId: id,
      metadata: { name, slug },
    });
  });

  return getOrganization(sql, id);
}

export async function setQuotas(
  sql: Sql,
  orgId: string,
  quotas: Partial<Quotas>,
  actorId: string | null,
): Promise<OrgSummary> {
  const clean: Partial<Quotas> = {};
  for (const [key, value] of Object.entries(quotas) as [keyof Quotas, number | undefined][]) {
    if (value === undefined) continue;
    const limit = QUOTA_LIMITS[key];
    if (!limit) throw new AdminError('invalid', `unknown quota "${key}"`);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < limit.min || value > limit.max) {
      throw new AdminError('invalid', `${key} must be a whole number between ${limit.min} and ${limit.max}`);
    }
    clean[key] = value;
  }

  await withStaff(sql, async (tx) => {
    const [org] = await tx`select id from organizations where id = ${orgId}`;
    if (!org) throw new AdminError('not_found', 'no such organisation');

    await tx`
      insert into org_quotas (org_id, renders_per_day, gpu_seconds_per_month, storage_bytes,
                              max_concurrent_jobs, max_resolution_px)
      values (${orgId},
              ${clean.rendersPerDay ?? 50}, ${clean.gpuSecondsPerMonth ?? 36000},
              ${clean.storageBytes ?? 53687091200}, ${clean.maxConcurrentJobs ?? 3},
              ${clean.maxResolutionPx ?? 4096})
      on conflict (org_id) do update set
        renders_per_day = coalesce(${clean.rendersPerDay ?? null}, org_quotas.renders_per_day),
        gpu_seconds_per_month = coalesce(${clean.gpuSecondsPerMonth ?? null}, org_quotas.gpu_seconds_per_month),
        storage_bytes = coalesce(${clean.storageBytes ?? null}, org_quotas.storage_bytes),
        max_concurrent_jobs = coalesce(${clean.maxConcurrentJobs ?? null}, org_quotas.max_concurrent_jobs),
        max_resolution_px = coalesce(${clean.maxResolutionPx ?? null}, org_quotas.max_resolution_px)`;

    await recordAudit(tx, {
      orgId,
      actorUserId: actorId,
      action: 'org.quotas_changed',
      targetType: 'organization',
      targetId: orgId,
      metadata: clean,
    });
  });

  return getOrganization(sql, orgId);
}

export async function setOrgStatus(
  sql: Sql,
  orgId: string,
  status: 'active' | 'suspended',
  actorId: string | null,
): Promise<OrgSummary> {
  await withStaff(sql, async (tx) => {
    const [row] = await tx`update organizations set status = ${status} where id = ${orgId} returning id`;
    if (!row) throw new AdminError('not_found', 'no such organisation');

    // Suspending an organisation ends its sessions: otherwise the people already signed in keep
    // working, and "suspended" means nothing until their cookies expire.
    if (status === 'suspended') {
      await tx`update sessions set revoked_at = now() where org_id = ${orgId} and revoked_at is null`;
    }

    await recordAudit(tx, {
      orgId,
      actorUserId: actorId,
      action: `org.${status}`,
      targetType: 'organization',
      targetId: orgId,
    });
  });

  return getOrganization(sql, orgId);
}

function toSummary(row: Record<string, unknown>): OrgSummary {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    slug: row['slug'] as string,
    status: row['status'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
    users: Number(row['user_count']),
    designs: Number(row['design_count']),
    rendersToday: Number(row['renders_today']),
    quotas: {
      rendersPerDay: Number(row['renders_per_day']),
      gpuSecondsPerMonth: Number(row['gpu_seconds_per_month']),
      storageBytes: Number(row['storage_bytes']),
      maxConcurrentJobs: Number(row['max_concurrent_jobs']),
      maxResolutionPx: Number(row['max_resolution_px']),
    },
  };
}

const normalizeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
