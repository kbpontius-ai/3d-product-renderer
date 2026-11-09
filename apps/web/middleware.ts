import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers, and a Content-Security-Policy with a per-request nonce (docs/05-security.md).
 *
 * The checklist asks for a CSP with nonces and no `unsafe-inline`, which is worth being precise
 * about because "we have a CSP" is a sentence people say about policies that permit everything.
 * What follows is deliberately close to the minimum this application actually needs, and every
 * relaxation below is one the app was proven to need rather than one added pre-emptively.
 *
 * The nonce goes on the *request* as well as the response: Next reads it back out of the request's
 * policy header and stamps it onto the scripts it emits, which is what allows `script-src` to name
 * a nonce instead of allowing inline script wholesale.
 */

/** Directives that do not depend on the request. */
function policy(nonce: string, production: boolean): string {
  return [
    // Nothing loads from anywhere unless a directive below says otherwise.
    `default-src 'self'`,

    // `strict-dynamic` lets the nonced bootstrap load the chunks it needs without naming each one.
    // Development additionally needs `unsafe-eval`, which is how the dev server does hot reloading;
    // production does not get it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? '' : " 'unsafe-eval'"}`,

    // Stylesheets come from the app's own build. Inline *attributes* are a separate directive:
    // React writes `style={{…}}` as a style attribute, which `style-src-attr` governs, and there is
    // no nonce mechanism for attributes. Splitting them keeps the stylesheet rule strict rather
    // than weakening both with one `unsafe-inline`.
    `style-src 'self'`,
    `style-src-attr 'unsafe-inline'`,

    // `data:` and `blob:` are for the editor's own canvases: the thumbnail it captures and the
    // textures it composites never leave the browser.
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `worker-src 'self' blob:`,

    // Nothing here embeds anything, is embedded by anything, or posts anywhere else.
    `object-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `form-action 'self'`,
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const production = process.env.NODE_ENV === 'production';
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = policy(nonce, production);

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);

  // A content type this server did not declare is not one a browser should guess at.
  response.headers.set('x-content-type-options', 'nosniff');
  // Referrers leak design and render ids into other people's logs; an origin is enough.
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  // Belt and braces with `frame-ancestors`, for anything that still reads the older header.
  response.headers.set('x-frame-options', 'DENY');
  // None of these are used, so none of them should be available to anything that gets injected.
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Only meaningful over TLS, and actively unhelpful on a development machine on plain HTTP.
  if (production) {
    response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  return response;
}

export const config = {
  // Everything except the immutable build output, which is served straight from disk and gains
  // nothing from a policy it cannot execute.
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};
