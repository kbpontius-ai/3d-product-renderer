import { countAudit, listAudit } from '@pr/admin';
import { getAdminOrganization } from '@/lib/server/admin-org';
import { getSql } from '@/lib/server/db';
import { AdminPagination } from '@/components/admin-pagination';
import { currentPage, listQuery, PAGE_SIZE } from '@/lib/admin-list';

const LABELS: Record<string, string> = {
  'org.created': 'Organization created',
  'org.quotas_changed': 'Usage limits changed',
  'user.role_changed': 'Account role changed',
  'user.suspended': 'Account suspended',
  'user.active': 'Account restored',
  'user.deleted': 'Account removed',
  'invite.created': 'Invitation created',
  'invite.revoked': 'Invitation revoked',
};

export default async function OrganizationActivity({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const org = await getAdminOrganization(id);
  const requested = listQuery.parse(await searchParams).page;
  const total = await countAudit(getSql(), id);
  const page = currentPage(requested, total);
  const entries = await listAudit(getSql(), {
    orgId: id,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  return (
    <div data-testid="org-activity">
      <h2>Activity</h2>
      <p className="auth-sub">Recorded changes for {org.name}.</p>
      <div className="table-wrap">
        <table className="admin-table org-activity-table" data-testid="org-audit">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Change</th>
              <th>Subject / details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>
                  {entry.actorEmail ??
                    (entry.actorUserId ? 'Former account' : 'System / account no longer recorded')}
                </td>
                <td>
                  {LABELS[entry.action] ?? entry.action.replace(/[._]/g, ' ')}
                  <small>{entry.action}</small>
                </td>
                <td>
                  {entry.targetEmail ??
                    (typeof entry.metadata['email'] === 'string'
                      ? entry.metadata['email']
                      : entry.targetType === 'org' || entry.targetType === 'organization'
                        ? org.name
                        : (entry.targetId ?? '—'))}
                  {Object.keys(entry.metadata).length > 0 && (
                    <details>
                      <summary>Details</summary>
                      <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length === 0 && <p className="readout">No recorded changes yet.</p>}
      <AdminPagination path={`/admin/orgs/${id}/activity`} page={page} total={total} />
    </div>
  );
}
