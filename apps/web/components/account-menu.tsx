import type { Role } from '@pr/auth';
import { SignOutButton } from '../app/(auth)/auth-forms';

/**
 * The account menu at the right of the nav pill (F-NAV-01).
 *
 * A `<details>` element rather than a state-driven popover, and deliberately: this is the only
 * route to `/account`, `/org` and `/admin`, so it has to work before hydration. The editor is the
 * one client-heavy island in this application (docs/19-frontend.md); navigation is not, and making
 * the way out of a page depend on JavaScript arriving would be a poor trade for an animation.
 *
 * The role gates here are convenience, not security. `/org` and `/admin` are guarded in their own
 * layouts and again in every route that reads or changes anything — hiding a link the server would
 * refuse anyway just stops people finding a door that will not open for them.
 */
export function AccountMenu({ email, role }: { email: string; role: Role }) {
  // Staff see the organisation area too: `/org` admits owner and staff alike, and a staff member
  // who lands there should not be told it does not exist.
  const canSeeOrg = role === 'owner' || role === 'staff';

  return (
    <details className="account-menu" data-testid="account-menu">
      <summary aria-label="Account menu" data-testid="account-menu-trigger">
        <span className="account-menu-initial" aria-hidden>
          {email.slice(0, 1).toUpperCase()}
        </span>
      </summary>

      <div className="account-menu-panel" role="menu">
        <p className="account-menu-email" title={email}>
          {email}
        </p>
        <a href="/account" role="menuitem" data-testid="nav-account">
          Account
        </a>
        {canSeeOrg && (
          <a href="/org" role="menuitem" data-testid="nav-org">
            Organization
          </a>
        )}
        {role === 'staff' && (
          <a href="/admin" role="menuitem" data-testid="admin-link">
            Admin
          </a>
        )}
        <div className="account-menu-sep" aria-hidden />
        <SignOutButton testId="nav-sign-out" />
      </div>
    </details>
  );
}
