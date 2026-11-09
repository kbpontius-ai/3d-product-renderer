import { log } from '@pr/observability';
import type { Mailer } from './mailer.js';

/**
 * Addresses that can never belong to anyone (F-PLAT-09).
 *
 * RFC 2606 reserves `example.com`, `example.net` and `example.org` for documentation, and RFC 2606
 * and 6761 reserve the `.test`, `.example`, `.invalid` and `.localhost` top-level domains. No
 * registry will ever delegate them, so mail to one of them cannot be delivered — and every
 * recipient in this repository's test suites is on one of them.
 *
 * That last part is the point. The test suites create accounts by the dozen and trigger invitations
 * and resets for each, and those processes inherit whatever environment they were started in. With
 * a real API key in the shell, a run of the end-to-end suite used to send every one of those
 * messages to the provider, which then bounced them against a sending domain with no reputation to
 * spend. Scrubbing the key out of each launcher is worth doing, but it depends on every launcher —
 * including ones not written yet — remembering to. This does not.
 */

const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];

export function isReservedRecipient(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return false;

  // Subdomains included: `mail.example.com` is no more deliverable than `example.com`.
  if (RESERVED_DOMAINS.some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`))) {
    return true;
  }
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return RESERVED_TLDS.includes(tld);
}

/**
 * Wraps a real transport so it never hands a reserved address to the provider.
 *
 * Declining rather than throwing: the address is undeliverable by definition, so not sending is the
 * correct outcome rather than a failure, and a throw would only resurface as a second, vaguer
 * warning from whichever caller caught it. The development mailbox is deliberately not wrapped —
 * the e2e suite reads `@example.com` messages back out of it, which is exactly what it is for.
 */
export function refuseReservedRecipients(inner: Mailer): Mailer {
  return {
    async send(message) {
      if (isReservedRecipient(message.to)) {
        log.warn('mail not sent: the recipient is on a reserved domain', {
          to: message.to,
          template: message.template,
        });
        return { delivered: false, reason: 'reserved_recipient' };
      }
      return inner.send(message);
    },
  };
}
