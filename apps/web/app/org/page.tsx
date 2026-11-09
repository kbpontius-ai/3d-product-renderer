import { orgOverview } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { actorFor, requireOwner } from '@/lib/server/org';

/** Where the organisation stands: seats, and what it is allowed to spend (F-ORG-04). */
export const dynamic = 'force-dynamic';

export default async function OrgOverviewPage() {
  const principal = await requireOwner();
  const overview = await orgOverview(getSql(), actorFor(principal));

  return (
    <section data-testid="org-overview">
      <header className="admin-head">
        <div>
          <h1>{overview.name}</h1>
          <p className="auth-sub">
            {overview.seats.active} active
            {overview.seats.invited > 0 ? `, ${overview.seats.invited} invited` : ''}
            {overview.seats.suspended > 0 ? `, ${overview.seats.suspended} suspended` : ''}.
          </p>
        </div>
      </header>

      <dl className="admin-stats" data-testid="org-stats">
        <div>
          <dt>Seats</dt>
          <dd data-testid="stat-seats">{overview.seats.total}</dd>
        </div>
        <div>
          <dt>Renders today</dt>
          <dd data-testid="stat-renders">
            {overview.rendersToday} / {overview.quotas.rendersPerDay}
          </dd>
        </div>
        <div>
          <dt>Largest render</dt>
          <dd>{overview.quotas.maxResolutionPx} px</dd>
        </div>
      </dl>

      {/*
        Quotas are shown and not edited. The policy has said so since it was written — `quota.write`
        is staff-only, `quota.read` is an owner action — and a form that submitted to a refusal
        would be a worse experience than no form.
      */}
      <p className="readout">
        Quotas are set by support. Ask if this organization needs more headroom.
      </p>
    </section>
  );
}
