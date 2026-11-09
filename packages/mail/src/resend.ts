import { log } from '@pr/observability';
import type { SendResult, Mailer, MailMessage } from './mailer.js';
import { renderMail } from './templates.js';

/**
 * Sending through Resend (F-PLAT-09).
 *
 * One `POST https://api.resend.com/emails` with a bearer token, over the global `fetch` Node 22
 * already has. No SDK: the vendor package would put itself in the dependency tree of both the web
 * app and the render worker to save the twenty lines below, and the whole point of the `Mailer`
 * seam is that swapping provider is editing this file.
 *
 * The API host has to be reachable from wherever this runs. That failure arrives at runtime, not at
 * deploy time, which is why `send` reports the status it got rather than a generic failure.
 */

const ENDPOINT = 'https://api.resend.com/emails';

/** Long enough for a slow API, short enough that a render worker is not held up by one. */
const TIMEOUT_MS = 10_000;

export interface ResendOptions {
  apiKey: string;
  /** Envelope sender, e.g. `3D Product Renderer <no-reply@mail.example.com>`. */
  from: string;
  replyTo?: string;
  /** Injected in tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

/** Base64 without pulling in a polyfill: Node has Buffer, and this only ever runs server-side. */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export function resendMailer(options: ResendOptions): Mailer {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async send(message: MailMessage): Promise<SendResult> {
      const rendered = renderMail(message);

      const body: Record<string, unknown> = {
        from: options.from,
        to: [message.to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(options.replyTo ? { reply_to: options.replyTo } : {}),
      };

      if (message.attachments?.length) {
        // `content_id` is what makes an attachment inline rather than a download; Resend matches it
        // against `cid:` references in the HTML.
        body['attachments'] = message.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: toBase64(attachment.bytes),
          content_type: attachment.contentType,
          ...(attachment.cid ? { content_id: attachment.cid } : {}),
        }));
      }

      const response = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        // The body carries the reason — an unverified domain, a malformed sender — and it is the
        // difference between "mail is broken" and "add this DNS record". The API key is not in it.
        const detail = await response.text().catch(() => '');
        throw new Error(`resend refused the message: ${response.status} ${detail.slice(0, 300)}`);
      }
      return { delivered: true };
    },
  };
}

/**
 * A mailer for deployments with no provider configured: says what it would have sent.
 *
 * Moved here from `@pr/notifications`, which is not where a default transport belongs now that
 * more than one thing sends mail.
 */
export const logMailer: Mailer = {
  async send(message) {
    log.info('mail not sent (no provider configured)', { to: message.to, template: message.template });
    return { delivered: false, reason: 'no_provider' };
  },
};
