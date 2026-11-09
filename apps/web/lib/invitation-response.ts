import type { SendResult } from '@pr/mail';

/**
 * What an invitation route tells the person who sent it (F-AUTH-01, F-AUTH-02).
 *
 * Two things this used to get wrong. It always returned the invitation link, so whoever invited
 * somebody could accept on their behalf, and accepting stopped proving the invitee controls the
 * mailbox. And it said "sent" whatever the mailer did. Now the link comes back only where
 * development tooling is on (a local machine, the e2e suite), and the response says whether the email
 * actually left and, if not, why — so a missing mail provider shows up the first time anyone invites.
 */
export interface InvitationResponse {
  email: string;
  delivered: boolean;
  /** Why no email went, in words for the person who pressed the button. */
  notDelivered?: string;
  /** Development only. */
  url?: string;
}

const REASONS: Record<Exclude<SendResult, { delivered: true }>['reason'], string> = {
  no_provider: 'no mail provider is configured on this deployment',
  reserved_recipient: 'that address is on a reserved domain that can never receive mail',
  captured: 'development mode keeps mail in the local mailbox instead of sending it',
  failed: 'the mail provider refused the message or could not be reached — try Resend in a moment',
};

export function invitationResponse(
  input: { email: string; token: string; delivery: SendResult },
  options: { appUrl: string; exposeLink: boolean },
): InvitationResponse {
  return {
    email: input.email,
    delivered: input.delivery.delivered,
    ...(input.delivery.delivered ? {} : { notDelivered: REASONS[input.delivery.reason] }),
    ...(options.exposeLink
      ? { url: `${options.appUrl.replace(/\/$/, '')}/invite/accept?token=${input.token}` }
      : {}),
  };
}
