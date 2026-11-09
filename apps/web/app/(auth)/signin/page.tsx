import { redirect } from 'next/navigation';
import { SignInForm } from '../auth-forms';
import { getPrincipal } from '@/lib/server/auth';
import { databaseConfigured } from '@/lib/server/db';
import { NotConfigured } from '../not-configured';

/**
 * Rendered per request, never prerendered: these pages depend on the session cookie and on runtime
 * configuration, and a build-time snapshot would freeze whichever state the build machine was in.
 */
export const dynamic = 'force-dynamic';


export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!databaseConfigured()) return <NotConfigured />;

  const { next } = await searchParams;
  if (await getPrincipal()) redirect(next ?? '/account');

  // Only same-origin paths, so a crafted ?next= cannot bounce someone off-site after signing in.
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/account';
  return <SignInForm next={target} />;
}
