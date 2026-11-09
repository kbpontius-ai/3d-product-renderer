'use client';

import { useState } from 'react';
import type { OrgSummary } from '@pr/admin';

export function OrganizationTable({ organizations }: { organizations: OrgSummary[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const visible = organizations.filter((org) =>
    `${org.name} ${org.slug}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!status || org.status === status),
  );
  return <>
    <dl className="org-summary">
      <div><dt>Organizations</dt><dd>{organizations.length}</dd></div>
      <div><dt>People</dt><dd>{organizations.reduce((sum, org) => sum + org.users, 0)}</dd></div>
      <div><dt>Renders today</dt><dd>{organizations.reduce((sum, org) => sum + org.rendersToday, 0)}</dd></div>
    </dl>
    <div className="library-toolbar">
      <input aria-label="Search organizations" placeholder="Search organizations…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="Organization status" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option>
      </select>
    </div>
    <div className="table-wrap"><table className="admin-table" data-testid="org-table">
      <thead><tr><th>Organization</th><th className="numeric">People</th><th className="numeric">Designs</th><th className="numeric">Renders today</th><th className="numeric">Daily limit</th><th>Status</th></tr></thead>
      <tbody>{visible.map((org) => <tr key={org.id} data-testid={`org-${org.slug}`}>
        <td><a href={`/admin/orgs/${org.id}`}><strong>{org.name}</strong></a><small>{org.slug}</small></td>
        <td className="numeric"><a href={`/admin/orgs/${org.id}/people`}>{org.users}</a></td><td className="numeric">{org.designs}</td>
        <td className="numeric">{org.rendersToday}</td><td className="numeric">{org.quotas.rendersPerDay}</td>
        <td><span className={org.status === 'active' ? 'pill ok' : 'pill warn'}>{org.status}</span></td>
      </tr>)}</tbody>
    </table></div>
    {visible.length === 0 && <p className="auth-sub">No organizations match your filters.</p>}
    <p className="auth-sub">{visible.length} of {organizations.length} organizations · Open an organization to manage people and limits.</p>
  </>;
}
