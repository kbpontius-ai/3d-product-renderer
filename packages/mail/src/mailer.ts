/**
 * What a mailer is, for everything that sends mail (F-PLAT-09).
 *
 * This interface used to exist twice — once in `@pr/auth` and once in `@pr/notifications` — with
 * identical shapes and no relationship, so a change to one was a silent divergence from the other.
 * Both now re-export this.
 *
 * A message names a template rather than carrying a subject and a body. Callers are the auth
 * service and the render worker, neither of which should be composing prose, and the split is what
 * lets the development mailbox record what *would* have been sent without rendering anything.
 */

/** A file carried with the message. `cid` makes it referenceable as `<img src="cid:…">`. */
export interface Attachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  /**
   * Content-ID for an inline image.
   *
   * Present means the image is part of the body rather than something to download. The render
   * notification needs this because a render's URL is signed per viewer and short-lived
   * (`F-PLAT-04`), so a linked thumbnail would be dead by the time the mail was opened.
   */
  cid?: string;
}

export interface MailMessage {
  to: string;
  template: string;
  vars: Record<string, unknown>;
  attachments?: Attachment[];
}

/**
 * What became of a message: whether it left for the recipient, and if not, why.
 *
 * Callers used to learn nothing, so a form said "Invitation sent" whether the provider took the
 * message, refused a reserved address, or no provider was configured at all.
 */
export type SendResult =
  | { delivered: true }
  | {
      delivered: false;
      /**
       * `no_provider`: nothing is configured to send mail. `reserved_recipient`: the address can
       * never receive mail (`example.com`, `.test`, …). `captured`: kept in the development
       * mailbox instead. `failed`: the provider was asked and refused, or could not be reached.
       */
      reason: 'no_provider' | 'reserved_recipient' | 'captured' | 'failed';
    };

export interface Mailer {
  /** Resolving with nothing means delivered as far as the transport can tell — older mailers and test stubs. */
  send(message: MailMessage): Promise<SendResult | void>;
}
