import { notFound, redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { SectionNav, type SectionGroup } from '@/components/section-nav';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured } from '@/lib/server/db';
import { NotConfigured } from '../(auth)/not-configured';

/**
 * The organisation area (W-16).
 *
 * Owner-facing and one organisation at a time — the opposite of `/admin`, which is staff-only and
 * cross-tenant by construction. They are separate routes rather than one console with a role check
 * because the staff pages list every account in every organisation: putting an owner behind a flag
 * inside them would mean re-auditing each page, forever, including the ones added later.
 *
 * Guarded here and again in every route that reads or changes anything. A layout guard alone leaves
 * the API open to anyone who guesses a path.
 */

export const dynamic = 'force-dynamic';

/**
 * Four sections, ungrouped (F-NAV-03).
 *
 * The staff console groups because six flat tabs stop reading as a set; four do not, and inventing
 * headings for them would be structure for its own sake. Same component, same sidebar, one
 * argument different.
 */
const GROUPS: SectionGroup[] = [
  {
    links: [
      { href: '/org', label: 'Overview' },
      { href: '/org/people', label: 'People' },
      { href: '/org/catalog', label: 'Products' },
      { href: '/org/activity', label: 'Activity' },
    ],
  },
];

export default async function OrgLayout({ children }: { children: React.ReactNode }) {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/org');
  // A member gets what a stranger gets. Whether this organisation has an administration area is
  // not something to learn from an error code.
  if (principal.role !== 'owner' && principal.role !== 'staff') notFound();

  return (
    <>
      <AppNav />
      <div className="console" data-testid="org">
        <SectionNav title="Organization" groups={GROUPS} testIdPrefix="org" />
        <main className="console-main">{children}</main>
      </div>
    </>
  );
}
