import 'server-only';
import { NextResponse } from 'next/server';
import { currentLog } from '@pr/observability';
import { AuthError } from '@pr/auth';
import { AdminError } from '@pr/admin';
import { ArtworkError } from '@pr/artworks';
import { DesignError } from '@pr/designs';
import { QueueError } from '@pr/job-queue';

/**
 * Error shaping for the API routes.
 *
 * Lives outside the route files because Next only permits HTTP method exports from a route module —
 * and because one place deciding what an error looks like from outside is how the coarse,
 * enumeration-safe vocabulary stays coarse.
 */

export function problem(code: string, status: number, detail?: unknown) {
  return NextResponse.json({ error: { code, ...(detail ? { detail } : {}) } }, { status });
}

/** An error a route wants to become a specific response, thrown from anywhere inside it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Shown to the caller, so write it for a person. */
    readonly detail?: unknown,
  ) {
    super(typeof detail === 'string' ? detail : code);
    this.name = 'HttpError';
  }
}

const QUEUE_STATUS: Record<string, number> = {
  not_found: 404,
  quota_exceeded: 429,
  too_many_running: 429,
  not_cancelable: 409,
  not_retryable: 409,
};

/** Admin messages are written for the administrator reading them, so they are passed through. */
const ADMIN_STATUS: Record<AdminError['code'], number> = {
  not_found: 404,
  invalid: 422,
  conflict: 409,
  forbidden: 403,
};

const DESIGN_STATUS: Record<DesignError['code'], number> = {
  not_found: 404,
  version_conflict: 409,
  invalid_document: 422,
  unknown_variant: 404,
};

/**
 * The single catch for every route that is not the auth pair.
 *
 * A version conflict is a 409 with the current version attached, because the client's next move is
 * to reload and rebase rather than to retry the same body.
 */
export function handleRouteError(error: unknown) {
  if (error instanceof HttpError) return problem(error.code, error.status, error.detail);
  if (error instanceof AdminError)
    return problem(error.code, ADMIN_STATUS[error.code], error.message);
  if (error instanceof DesignError) {
    return problem(error.code, DESIGN_STATUS[error.code], error.detail);
  }
  if (error instanceof QueueError) {
    return problem(error.code, QUEUE_STATUS[error.code] ?? 400, error.detail);
  }
  if (error instanceof ArtworkError) {
    const status =
      error.code === 'too_large'
        ? 413
        : error.code === 'invalid'
          ? 422
          : error.code === 'in_use' ||
              error.code === 'version_conflict' ||
              error.code === 'archived_artwork'
            ? 409
            : 404;
    if (error.code === 'archived_artwork')
      return NextResponse.json(
        {
          error: {
            code: error.code,
            detail: error.message,
            archivedArtworks: error.archivedArtworks ?? [],
          },
        },
        { status },
      );
    return problem(error.code, status, error.message);
  }
  if (error instanceof AuthError) return handleAuthError(error);
  if (error instanceof Error && error.message === 'cross-origin request refused') {
    return problem('forbidden', 403);
  }
  currentLog().error('unhandled route error', error);
  return problem('internal', 500);
}

export function handleAuthError(error: unknown) {
  if (error instanceof AuthError) {
    // Only rate limiting is distinguishable, because the client needs to know to back off.
    const status = error.code === 'rate_limited' ? 429 : error.code === 'forbidden' ? 403 : 401;
    return problem(error.code, status, error.detail);
  }
  if (error instanceof Error && error.message === 'cross-origin request refused') {
    return problem('forbidden', 403);
  }
  currentLog().error('unhandled auth error', error);
  return problem('internal', 500);
}

export const clientIp = (request: Request): string | undefined =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined;
