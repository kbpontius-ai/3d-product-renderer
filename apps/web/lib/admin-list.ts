import { z } from 'zod';

export const PAGE_SIZE = 50;
export const listQuery = z.object({
  q: z.string().trim().max(254).catch('').default(''),
  role: z.enum(['staff', 'owner', 'member']).optional().catch(undefined),
  status: z.enum(['invited', 'active', 'suspended']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
});

export function currentPage(requested: number, total: number): number {
  return Math.min(requested, Math.max(1, Math.ceil(total / PAGE_SIZE)));
}
