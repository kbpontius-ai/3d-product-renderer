import { log } from '@pr/observability';
import { logMailer, type Mailer } from '@pr/mail';
import { withStaff, type Sql } from '@pr/db';
import { recordNotification, type NotificationKind } from './notifications.js';

/**
 * What the worker says when a render ends (F-REND-08).
 *
 * Two channels, one decision. The bell always gets a row — it costs nothing and is there whenever
 * the person comes back. Email is only for renders slow enough that nobody sat and watched: a mail
 * for a nine-second draft is noise, and noise is how people learn to ignore mail that matters.
 */

/** Below this, the person was almost certainly still looking at the tab. */
export const EMAIL_AFTER_SECONDS = 90;

/**
 * Both re-exported from `@pr/mail` rather than declared here.
 *
 * This interface used to exist in two places with identical shapes and no relationship, which meant
 * a change to one was a silent divergence from the other. A default transport is likewise not this
 * package's business now that more than one thing sends mail.
 */
export { logMailer, type Mailer } from '@pr/mail';

export interface RenderOutcome {
  jobId: string;
  orgId: string;
  designId: string | null;
  /** Who asked for it; null when the account has since been removed. */
  userId: string | null;
  status: 'succeeded' | 'failed' | 'canceled';
  seconds: number;
  failure?: { code: string; message: string } | undefined;
}

export async function notifyRenderFinished(
  sql: Sql,
  outcome: RenderOutcome,
  options: { mailer?: Mailer; appUrl?: string } = {},
): Promise<void> {
  if (!outcome.userId) return;

  const kind = `render.${outcome.status}` as NotificationKind;
  const link = outcome.designId ? `/design/${outcome.designId}` : '/renders';
  const title =
    outcome.status === 'succeeded'
      ? 'Your render is ready'
      : outcome.status === 'failed'
        ? 'A render failed'
        : 'A render was cancelled';
  const body =
    outcome.status === 'succeeded'
      ? `Finished in ${formatDuration(outcome.seconds)}.`
      : (outcome.failure?.message ?? null);

  const recipient = await withStaff(sql, async (tx) => {
    await recordNotification(tx, {
      orgId: outcome.orgId,
      userId: outcome.userId,
      kind,
      title,
      ...(body ? { body } : {}),
      link,
      metadata: { jobId: outcome.jobId, seconds: Math.round(outcome.seconds) },
    });

    const [user] = await tx`
      select email, notify_email from users where id = ${outcome.userId}`;
    return user ? { email: String(user['email']), wantsEmail: user['notify_email'] === true } : null;
  });

  // A cancellation was somebody's own decision; they do not need telling twice.
  const worthEmailing =
    outcome.status !== 'canceled' &&
    (outcome.status === 'failed' || outcome.seconds >= EMAIL_AFTER_SECONDS);

  if (!recipient?.wantsEmail || !worthEmailing) return;

  const mailer = options.mailer ?? logMailer;
  const appUrl = (options.appUrl ?? '').replace(/\/$/, '');

  try {
    await mailer.send({
      to: recipient.email,
      template: outcome.status === 'succeeded' ? 'render-ready' : 'render-failed',
      vars: {
        title,
        body,
        url: `${appUrl}${link}`,
        seconds: Math.round(outcome.seconds),
        ...(outcome.failure ? { failure: outcome.failure.code } : {}),
      },
    });
  } catch (error) {
    // A mail provider being down must not fail a render that already succeeded; the bell has it.
    log.warn('could not send the render notification', { jobId: outcome.jobId, error: String(error) });
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}
