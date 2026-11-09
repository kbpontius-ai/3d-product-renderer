export { type Attachment, type Mailer, type MailMessage, type SendResult } from './mailer.js';
export { escapeHtml, renderMail, templateNames, type RenderedMail } from './templates.js';
export { logMailer, resendMailer, type ResendOptions } from './resend.js';
export { mailerFromEnv } from './from-env.js';
export { isReservedRecipient, refuseReservedRecipients } from './reserved.js';
