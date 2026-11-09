import 'server-only';
import { mailerFromEnv, type Mailer } from '@pr/mail';
import { devToolingEnabled } from './dev-only.js';

/**
 * Which mailer this process sends through (F-PLAT-09).
 *
 * Three cases, in order. A configured provider wins, because a deployment that has one wants it
 * used. Otherwise development tooling gets the in-memory mailbox, which is what the e2e suite reads
 * through `/api/dev/mail`. Otherwise nothing is sent and a line says so.
 *
 * This used to be `devMailer` unconditionally, including in production, where it *throws*. That was
 * not a missing feature but a live defect: `createInvitation` returned 500 after committing the
 * invitation, and `requestPasswordReset` answered 500 for an address that existed against 204 for
 * one that did not — an enumeration oracle assembled out of a mailer that refused to run.
 */

export interface CapturedMail {
  to: string;
  template: string;
  vars: Record<string, unknown>;
  at: string;
}

const globalForMail = globalThis as unknown as { __prMail?: CapturedMail[] };
const store = (): CapturedMail[] => (globalForMail.__prMail ??= []);

export const devMailer: Mailer = {
  async send(message) {
    if (!devToolingEnabled()) {
      throw new Error('the development mailer is disabled; configure a real mail provider');
    }
    const captured: CapturedMail = { ...message, at: new Date().toISOString() };
    store().unshift(captured);
    store().length = Math.min(store().length, 20);
    console.info(`[mail] ${message.template} -> ${message.to}`, message.vars);
    return { delivered: false, reason: 'captured' };
  },
};

export const capturedMail = (): CapturedMail[] => [...store()];

/**
 * The application's mailer, decided once per process.
 *
 * Memoised on the global for the same reason the auth service is: Next re-evaluates modules across
 * requests in development, and a transport rebuilt per request is a warning logged per request.
 */
const globalForMailer = globalThis as unknown as { __prMailer?: Mailer };

export function getMailer(): Mailer {
  globalForMailer.__prMailer ??= devToolingEnabled() && !process.env['RESEND_API_KEY']
    ? devMailer
    : mailerFromEnv(process.env);
  return globalForMailer.__prMailer;
}
