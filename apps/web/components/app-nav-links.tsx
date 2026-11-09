'use client';

import { usePathname } from 'next/navigation';
import type { NavLink } from './app-nav';

export function AppNavLinks({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  return (
    <ul className="app-nav-links">
      {links.map((link) => (
        <li key={link.href}>
          <a
            href={link.href}
            data-testid={link.testId}
            aria-current={
              pathname === link.href || pathname.startsWith(`${link.href}/`) || (link.href === '/designs' && pathname.startsWith('/design/')) ? 'page' : undefined
            }
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}
