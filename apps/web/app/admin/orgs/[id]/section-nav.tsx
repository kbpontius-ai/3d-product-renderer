'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS = [
  { label: 'Overview', suffix: '' },
  { label: 'People', suffix: '/people' },
  { label: 'Products', suffix: '/products' },
  { label: 'Limits', suffix: '/limits' },
  { label: 'Activity', suffix: '/activity' },
];

export function OrganizationSections({ orgId }: { orgId: string }) {
  const pathname = usePathname();
  const base = `/admin/orgs/${orgId}`;
  return (
    <nav className="org-sections" aria-label="Organization sections">
      {SECTIONS.map(({ label, suffix }) => {
        const href = `${base}${suffix}`;
        const active = pathname === href || (suffix !== '' && pathname.startsWith(`${href}/`));
        return (
          <Link
            key={label}
            href={href}
            className={active ? 'active' : ''}
            aria-current={active ? 'page' : undefined}
            data-testid={`org-section-${label.toLowerCase()}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
