import { AcceptInviteForm } from '../../auth-forms';
import { databaseConfigured } from '@/lib/server/db';
import { NotConfigured } from '../../not-configured';

/**
 * Rendered per request, never prerendered: these pages depend on the session cookie and on runtime
 * configuration, and a build-time snapshot would freeze whichever state the build machine was in.
 */
export const dynamic = 'force-dynamic';


export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  if (!databaseConfigured()) return <NotConfigured />;

  const { token } = await searchParams;
  if (!token) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Invitation link incomplete</h1>
          <p className="auth-sub">
            Open the link from your invitation email, or ask whoever invited you to send a new one.
          </p>
        </div>
      </main>
    );
  }

  // The token is validated when the form is submitted: checking it here would leak whether a link
  // is live to anyone who can guess one.
  return <AcceptInviteForm token={token} />;
}
