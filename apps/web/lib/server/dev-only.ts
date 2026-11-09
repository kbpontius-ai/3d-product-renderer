import 'server-only';

/**
 * Development tooling: the invitation endpoint and the in-memory mailbox.
 *
 * They exist because the platform is invite-only and the admin console does not exist yet — without
 * them there would be no way to create the first account, or to read the link that was "sent".
 *
 * One switch turns them on, and production needs a second, explicitly acknowledged one: the
 * end-to-end suite runs a production build on purpose, so "not production" is not a strong enough
 * guard on its own.
 */
export function devToolingEnabled(): boolean {
  if (process.env['DEV_TOOLING'] !== 'true') return false;
  if (process.env.NODE_ENV === 'production' && process.env['ALLOW_DEV_TOOLING_IN_PRODUCTION'] !== 'true') {
    return false;
  }
  return true;
}
