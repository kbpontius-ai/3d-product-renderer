'use client';

import { usePathname } from 'next/navigation';

export interface SectionLink {
  href: string;
  label: string;
  /** Shown under the label. Omitted for short lists where the label already says enough. */
  hint?: string;
}

export interface SectionGroup {
  /** Omit for a flat list; the organisation area has only four entries and needs no headings. */
  heading?: string;
  links: SectionLink[];
}

export function SectionNav({
  title,
  groups,
  testIdPrefix,
}: {
  title: string;
  groups: SectionGroup[];
  testIdPrefix: string;
}) {
  const current = usePathname();

  return (
    <nav className="section-nav" aria-label={title} data-testid={`${testIdPrefix}-nav`}>
      <p className="section-nav-title">{title}</p>

      {groups.map((group, index) => (
        <div className="section-nav-group" key={group.heading ?? `group-${index}`}>
          {group.heading && <p className="section-nav-heading">{group.heading}</p>}
          <ul>
            {group.links.map((link) => {
              const active = current === link.href ||
                (link.href === '/admin' && current.startsWith('/admin/orgs/')) ||
                (link.href !== '/admin' && link.href !== '/org' && current.startsWith(`${link.href}/`));
              return (
                <li key={link.href}>
                  <a
                    href={link.href}
                    title={link.hint}
                    aria-current={active ? 'page' : undefined}
                    className={active ? 'active' : undefined}
                    data-testid={`${testIdPrefix}-nav-${link.label.toLowerCase()}`}
                  >
                    <span>{link.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
