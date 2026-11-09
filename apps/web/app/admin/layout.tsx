import { notFound, redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { SectionNav, type SectionGroup } from '@/components/section-nav';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured } from '@/lib/server/db';
import { NotConfigured } from '../(auth)/not-configured';

/**
 * The admin console (W-11..W-13).
 *
 * Everything under here is staff-only, checked once in the layout and again in every route that
 * changes something — a layout guard alone would leave the API open to anyone who guessed a path.
 */

export const dynamic = 'force-dynamic';

/**
 * Six sections, three jobs (F-NAV-02).
 *
 * They used to be a flat row of six tabs in the order they happened to be built. Grouped, the
 * console says what it is: who is on the platform, what they can put on it, and what it is doing
 * right now. The hints exist because "Packs" and "CAD" are not self-explanatory to anyone who has
 * not read `docs/23-cad-ingestion.md` — CAD ingestion drafts a pack, and pack import publishes
 * one, and which to reach for is the question the labels alone never answered.
 */
const GROUPS: SectionGroup[] = [
  {
    heading: 'Tenants',
    links: [
      { href: '/admin', label: 'Organizations', hint: 'Accounts, quotas, catalog access' },
    ],
  },
  {
    heading: 'Content',
    links: [
      { href: '/admin/packs', label: 'Packs', hint: 'Import, validate and publish products' },
      { href: '/admin/cad', label: 'CAD', hint: 'Turn a STEP file into a draft pack' },
      { href: '/admin/materials', label: 'Materials', hint: 'The shared finish library' },
    ],
  },
  {
    heading: 'Operations',
    links: [
      { href: '/admin/status', label: 'Status', hint: 'Every service, live renders, server errors' },
      { href: '/admin/queue', label: 'Queue', hint: 'Renders in flight, retries, failures' },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/admin');
  // Signed in but not staff gets the same answer a stranger would get from the API: this path does
  // not exist. Redirecting to sign-in instead would tell them it does — and, since they are already
  // signed in, would bounce them straight back here.
  if (principal.role !== 'staff') notFound();

  return (
    <>
      <AppNav />
      <div className="console" data-testid="admin">
        <SectionNav title="Admin" groups={GROUPS} testIdPrefix="admin" />
        <main className="console-main">{children}</main>
      </div>
    </>
  );
}
