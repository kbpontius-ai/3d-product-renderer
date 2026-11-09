import Link from 'next/link';
import { getAdminOrganization } from '@/lib/server/admin-org';
import { OrganizationSections } from './section-nav';

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const org = await getAdminOrganization(id);
  return (
    <section className="org-workspace" data-testid="org-detail">
      <Link className="org-breadcrumb" href="/admin">
        ← Organizations
      </Link>
      <header className="admin-head org-header">
        <div>
          <h1>{org.name}</h1>
          <p className="auth-sub">{org.slug}</p>
        </div>
        <span className={org.status === 'active' ? 'pill ok' : 'pill warn'}>
          {org.status} organization
        </span>
      </header>
      <OrganizationSections orgId={org.id} />
      {children}
    </section>
  );
}
