import { getAdminOrganization } from '@/lib/server/admin-org';
import { QuotaForm } from '../quota-form';

export default async function OrganizationLimits({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getAdminOrganization(id);
  return (
    <div className="org-limits" data-testid="org-limits">
      <h2>Limits</h2>
      <p className="auth-sub">Usage limits for {org.name}. Changes apply to future submissions.</p>
      <QuotaForm orgId={id} quotas={org.quotas} />
    </div>
  );
}
