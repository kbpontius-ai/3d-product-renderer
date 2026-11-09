import { CompleteResetForm, RequestResetForm } from '../auth-forms';
import { databaseConfigured } from '@/lib/server/db';
import { NotConfigured } from '../not-configured';

/**
 * Rendered per request, never prerendered: these pages depend on the session cookie and on runtime
 * configuration, and a build-time snapshot would freeze whichever state the build machine was in.
 */
export const dynamic = 'force-dynamic';


export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  if (!databaseConfigured()) return <NotConfigured />;
  const { token } = await searchParams;
  return token ? <CompleteResetForm token={token} /> : <RequestResetForm />;
}
