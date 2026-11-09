import { listAudit } from '@pr/admin';
import { getSql } from '@/lib/server/db';
import { requireOwner } from '@/lib/server/org';

/** What has been done to this organisation, and by whom (F-ORG-05). */
export const dynamic = 'force-dynamic';

export default async function OrgActivityPage() {
  const principal = await requireOwner();
  // Scoped by the organisation on the principal, never by one from the request: an id in a query
  // string is a request to read somebody else's history.
  const entries = await listAudit(getSql(), { orgId: principal.orgId, limit: 100 });

  return (
    <section>
      <header className="admin-head">
        <div>
          <h1>Activity</h1>
          <p className="auth-sub">The last {entries.length} changes in this organization.</p>
        </div>
      </header>

      <div className="table-wrap">
        <table className="admin-table" data-testid="org-activity-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td className="mono">{entry.action}</td>
                <td className="mono">{entry.targetId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {entries.length === 0 && <p className="readout">Nothing has happened yet.</p>}
    </section>
  );
}
