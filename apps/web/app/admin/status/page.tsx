import { requireStaff } from '@/lib/server/admin';
import { loadStatus } from '@/lib/server/system-status';
import { StatusBoard } from './status-board';

/**
 * System status (F-ADM-15): every service the platform runs on, what they are doing, and what has
 * gone wrong — in one place, refreshing itself.
 *
 * Rendered with data on the server so the first paint is already the answer; the board then polls
 * the same loader through `/api/admin/status`.
 */
export const dynamic = 'force-dynamic';

export default async function AdminStatusPage() {
  await requireStaff();
  return <StatusBoard initial={await loadStatus()} />;
}
