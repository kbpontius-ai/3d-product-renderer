export class ArtworkRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function artworkRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; detail?: string | { errors: { message: string; hint?: string }[] } };
    } | null;
    const detail = body?.error?.detail;
    const message =
      typeof detail === 'string'
        ? detail
        : detail?.errors
            ?.map((error) => [error.message, error.hint].filter(Boolean).join(' '))
            .join(' ');
    throw new ArtworkRequestError(
      message ||
        (response.status === 401
          ? 'Your session expired. Sign in again.'
          : response.status === 413
            ? 'That SVG is too large to upload.'
            : 'The request failed. Please try again.'),
      body?.error?.code,
    );
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}
