import { redirect } from 'next/navigation';

/**
 * Rendered per request so the Content-Security-Policy nonce can exist (docs/05-security.md).
 *
 * A nonce is a per-request value and this page's HTML would otherwise be generated once at build
 * time, which leaves its script tags unnonced and — under a policy naming a nonce and
 * `strict-dynamic` — blocked outright. The page then serves, renders, and does nothing when
 * clicked, which is a worse failure than a slow one because it looks like it worked.
 *
 * The cost is one server render of a page with no per-user content in it. That is a fair price for
 * a policy with no `unsafe-inline` in it.
 */
export const dynamic = 'force-dynamic';

/**
 * The root lands on the dashboard, not the editor.
 *
 * `/design/demo` is the editor against a fixture cap with no account and no database behind it. It
 * is what `preview:probe` and the screenshot script drive, and it stays reachable directly, but it
 * is not where somebody who signed in wants to start. The cost is that a signed-out visitor now
 * lands on `/signin?next=/designs` rather than a working editor — the honest answer for a product
 * nobody can sign up for.
 */
export default function Home() {
  redirect('/designs');
}
