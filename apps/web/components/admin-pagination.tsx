import Link from 'next/link';
import { PAGE_SIZE } from '@/lib/admin-list';

export function AdminPagination({
  path,
  page,
  total,
  filters = {},
}: {
  path: string;
  page: number;
  total: number;
  filters?: Record<string, string>;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (next: number) =>
    `${path}?${new URLSearchParams({ ...filters, page: String(next) })}`;
  return (
    <div className="org-pagination" data-testid="list-pagination">
      <span>
        {total === 0 ? '0' : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)}`}{' '}
        of {total}
      </span>
      <div>
        {page > 1 && <Link href={href(page - 1)}>Previous</Link>}
        <span>
          Page {page} of {pages}
        </span>
        {page < pages && <Link href={href(page + 1)}>Next</Link>}
      </div>
    </div>
  );
}
