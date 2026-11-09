import { log } from '@pr/observability';
import type { Mailer } from './mailer.js';
import { logMailer, resendMailer } from './resend.js';
import { refuseReservedRecipients } from './reserved.js';

/**
 * Which mailer a process gets, decided from the environment in one place (F-PLAT-09).
 *
 * Both the web app and the render worker need this decision and they must not answer it
 * differently — a deployment where invitations send and render notifications do not is worse than
 * one where neither does, because nobody notices the half that is broken.
 *
 * The fallback is a mailer that logs rather than one that throws. That is the correction of a real
 * defect: the web app used to hold the *development* mailbox unconditionally, which throws outside
 * development, so a production password reset answered 500 for an address that existed and 204 for
 * one that did not — the enumeration oracle `F-AUTH-04` exists to prevent, arrived at by accident.
 */

/**
 * Read by index rather than as named optional fields.
 *
 * An interface of all-optional properties is a weak type, and `process.env` declares no properties
 * in common with it, so passing the real environment fails to typecheck in the web app. An index
 * signature accepts both that and the plain objects the tests pass.
 */
export type MailEnv = Record<string, string | undefined>;

export function mailerFromEnv(env: MailEnv = process.env, override?: Mailer): Mailer {
  if (override) return override;

  const apiKey = env['RESEND_API_KEY']?.trim();
  const from = env['MAIL_FROM']?.trim();

  if (!apiKey) return logMailer;

  if (!from) {
    // Half-configured is its own failure, and one worth naming: with a key and no sender every
    // send would be refused by the API, one message at a time, for a reason nobody reads.
    log.warn('RESEND_API_KEY is set but MAIL_FROM is not; no mail will be sent');
    return logMailer;
  }

  const replyTo = env['MAIL_REPLY_TO']?.trim();
  // Every real transport is wrapped, so no process — web, worker, script, or one written later —
  // can hand the provider an address that is undeliverable by definition. See `reserved.ts`.
  return refuseReservedRecipients(resendMailer({ apiKey, from, ...(replyTo ? { replyTo } : {}) }));
}
