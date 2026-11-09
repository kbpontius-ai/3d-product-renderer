import { redirect } from 'next/navigation';
import { requireStaff } from '@/lib/server/admin';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await requireStaff();
  const { q } = await searchParams;
  redirect(typeof q === 'string' && q ? `/admin?${new URLSearchParams({ q })}` : '/admin');
}
