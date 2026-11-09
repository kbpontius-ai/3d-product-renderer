/**
 * Where a storage key is served from.
 *
 * The same shape the server helper builds, kept separately because this one runs in the browser:
 * the preview resolves a material's texture keys itself, and importing the server module for one
 * string would drag `server-only` into a client component.
 */
export const assetHref = (storageKey: string): string =>
  `/api/assets/${storageKey.split('/').map(encodeURIComponent).join('/')}`;
