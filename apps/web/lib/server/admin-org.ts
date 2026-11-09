import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AdminError, getOrganization } from '@pr/admin';
import { requireStaff } from './admin';
import { getSql } from './db';

export const getAdminOrganization = cache(async (id: string) => {
  await requireStaff();
  if (!z.string().uuid().safeParse(id).success) notFound();
  return getOrganization(getSql(), id).catch((error: unknown) => {
    if (error instanceof AdminError && error.code === 'not_found') notFound();
    throw error;
  });
});
