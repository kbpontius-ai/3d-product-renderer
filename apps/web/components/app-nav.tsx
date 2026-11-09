import { NotificationBell } from './notification-bell';
import { AccountMenu } from './account-menu';
import { AppNavLinks } from './app-nav-links';
import { getPrincipal } from '@/lib/server/auth';

export interface NavLink {
  href: string;
  label: string;
  testId?: string;
}

/** Where everyone goes. Ordered as the workflow runs: pick a product, place art, collect output. */
const PRIMARY: NavLink[] = [
  { href: '/designs', label: 'Designs', testId: 'nav-designs' },
  { href: '/artwork', label: 'Artwork', testId: 'nav-artwork' },
  { href: '/catalog', label: 'Catalog', testId: 'nav-catalog' },
  { href: '/renders', label: 'Renders', testId: 'nav-renders' },
];

export async function AppNav({ allowGuest = false }: { allowGuest?: boolean }) {
  const principal = await getPrincipal();
  if (!principal && !allowGuest) return null;

  return (
    <header className="app-nav-wrap">
      <nav className="app-nav" aria-label="Primary" data-testid="app-nav">
        <a className="app-nav-brand" href="/designs" data-testid="nav-home">
          <span className="logo" aria-hidden />
          <span className="app-nav-wordmark">3D Product Renderer</span>
        </a>

        <AppNavLinks links={PRIMARY} />

        <div className="app-nav-end">
          {principal ? (
            <>
              {principal.role === 'staff' && <AppNavLinks links={[{ href: '/admin', label: 'Admin', testId: 'nav-admin' }]} />}
              <NotificationBell />
              <AccountMenu email={principal.email} role={principal.role} />
            </>
          ) : <a className="auth-link" href="/signin">Sign in</a>}
        </div>
      </nav>
    </header>
  );
}
