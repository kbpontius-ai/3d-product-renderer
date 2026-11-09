import { redirect } from 'next/navigation';
import { SignOutButton } from '../../(auth)/auth-forms';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured } from '@/lib/server/db';
import { NotConfigured } from '../../(auth)/not-configured';

/**
 * Rendered per request, never prerendered: these pages depend on the session cookie and on runtime
 * configuration, and a build-time snapshot would freeze whichever state the build machine was in.
 */
export const dynamic = 'force-dynamic';


/**
 * A minimal signed-in surface: proof the session works end to end, and the place team management
 * and design listings will hang off once they exist.
 */
export default async function AccountPage() {
  if (!databaseConfigured()) return <NotConfigured />;

  const principal = await getPrincipal();
  if (!principal) redirect('/signin?next=/account');

  return (
    <main className="auth-shell">
      <div className="auth-card wide" data-testid="account">
        <span className="logo" aria-hidden />
        <h1>Account</h1>
        <p className="auth-sub">Your account and workspace access.</p>
        <dl className="account-details">
          <dt>Email</dt>
          <dd data-testid="account-email">{principal.email}</dd>
          <dt>Role</dt>
          <dd data-testid="account-role">{principal.role}</dd>
          <dt>Organization</dt>
          <dd className="mono">{principal.orgId}</dd>
        </dl>
        <div className="account-actions">
          <a className="auth-link" href="/designs">
            Open your designs
          </a>
          {/*
            The way in to the organisation area. Shown on role rather than fetched, because the
            page already has the principal — and the link is only a link: `/org` guards itself, so a
            member who guesses the path still gets a 404.
          */}
          {(principal.role === 'owner' || principal.role === 'staff') && (
            <a className="auth-link" href="/org" data-testid="account-org-link">
              Administer this organization
            </a>
          )}
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
