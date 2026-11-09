import type { MailMessage } from './mailer.js';

/**
 * Turning `{ template, vars }` into something a mail client can show (F-PLAT-09).
 *
 * Plain functions over a small vocabulary rather than a templating library: there are four
 * templates, they are transactional, and the thing that actually matters about them — that a
 * variable can never become markup — is easier to guarantee in fifty lines than to verify in a
 * dependency.
 *
 * Every template renders both HTML and text. The text part is not a courtesy: a message with no
 * text alternative scores worse with spam filters, and these are the messages that must arrive.
 */

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * HTML-escapes a value on its way into a template.
 *
 * Applied to every interpolation without exception. Most vars here are URLs and timestamps this
 * code generated, but `F-REND-14` will put a design name in one of these bodies, and a design name
 * is whatever a customer typed. The rule is easier to keep than to remember when to apply.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A URL safe to put in an `href`. Anything that is not http(s) becomes empty rather than markup. */
function safeUrl(value: unknown): string {
  const raw = String(value ?? '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return escapeHtml(url.toString());
  } catch {
    return '';
  }
}

/** When a token-bearing link stops working, in the recipient's words rather than an ISO string. */
function expiry(value: unknown): string {
  const at = new Date(String(value ?? ''));
  if (Number.isNaN(at.getTime())) return '';
  return at.toUTCString();
}

const layout = (heading: string, body: string, action?: { url: string; label: string }): string => `
<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f7f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0d0d0d;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;font-weight:500;">${heading}</h1>
    ${body}
    ${
      action && action.url
        ? `<p style="margin:24px 0 0;"><a href="${action.url}" style="display:inline-block;background:#0d0d0d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:16px;font-size:14px;">${escapeHtml(action.label)}</a></p>
    <p style="margin:16px 0 0;font-size:12px;color:#6b6b6b;word-break:break-all;">If the button does not work, paste this into your browser:<br>${action.url}</p>`
        : ''
    }
  </div>
</body>
</html>`;

type Template = (vars: Record<string, unknown>) => RenderedMail;

const templates: Record<string, Template> = {
  invite: (vars) => {
    const url = safeUrl(vars['url']);
    const until = expiry(vars['expiresAt']);
    return {
      subject: 'You have been invited to 3D Product Renderer',
      html: layout(
        'You have been invited',
        `<p style="margin:0;font-size:14px;line-height:1.6;">Somebody has invited you to 3D Product Renderer. Follow the link to choose a password and sign in.</p>
    ${until ? `<p style="margin:12px 0 0;font-size:13px;color:#6b6b6b;">This link works once, and stops working after ${escapeHtml(until)}.</p>` : ''}`,
        { url, label: 'Accept the invitation' },
      ),
      text: [
        'You have been invited to 3D Product Renderer.',
        '',
        'Follow the link to choose a password and sign in:',
        url,
        ...(until ? ['', `This link works once, and stops working after ${until}.`] : []),
      ].join('\n'),
    };
  },

  'password-reset': (vars) => {
    const url = safeUrl(vars['url']);
    const until = expiry(vars['expiresAt']);
    return {
      subject: 'Reset your 3D Product Renderer password',
      html: layout(
        'Reset your password',
        `<p style="margin:0;font-size:14px;line-height:1.6;">Somebody asked to reset the password for this address. If that was not you, nothing has changed and you can ignore this message.</p>
    ${until ? `<p style="margin:12px 0 0;font-size:13px;color:#6b6b6b;">This link works once, and stops working after ${escapeHtml(until)}.</p>` : ''}`,
        { url, label: 'Choose a new password' },
      ),
      text: [
        'Somebody asked to reset the password for this address.',
        'If that was not you, nothing has changed and you can ignore this message.',
        '',
        url,
        ...(until ? ['', `This link works once, and stops working after ${until}.`] : []),
      ].join('\n'),
    };
  },

  'render-ready': (vars) => {
    const url = safeUrl(vars['url']);
    const seconds = Number(vars['seconds']);
    const took = Number.isFinite(seconds) ? formatDuration(seconds) : '';
    return {
      subject: 'Your render is ready',
      html: layout(
        'Your render is ready',
        `<p style="margin:0;font-size:14px;line-height:1.6;">${escapeHtml(vars['body'] ?? 'Your render has finished.')}</p>
    ${took ? `<p style="margin:12px 0 0;font-size:13px;color:#6b6b6b;">Finished in ${escapeHtml(took)}.</p>` : ''}`,
        { url, label: 'Open the render' },
      ),
      text: ['Your render is ready.', ...(took ? [`Finished in ${took}.`] : []), '', url].join('\n'),
    };
  },

  'render-failed': (vars) => {
    const url = safeUrl(vars['url']);
    const reason = vars['body'] ? String(vars['body']) : '';
    return {
      subject: 'A render failed',
      html: layout(
        'A render failed',
        `<p style="margin:0;font-size:14px;line-height:1.6;">${escapeHtml(reason || 'The render did not finish. Opening the design will show what happened.')}</p>`,
        { url, label: 'Open the design' },
      ),
      text: [reason || 'The render did not finish.', '', url].join('\n'),
    };
  },
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Every template this build knows how to render. */
export const templateNames = (): string[] => Object.keys(templates).sort();

/**
 * Renders a message, or throws if nothing knows that template name.
 *
 * Throwing is deliberate. A template name is written by this codebase, never by a user, so an
 * unknown one is a programming error that should surface in a test rather than send a blank email.
 */
export function renderMail(message: Pick<MailMessage, 'template' | 'vars'>): RenderedMail {
  const template = templates[message.template];
  if (!template) throw new Error(`no mail template named "${message.template}"`);
  return template(message.vars);
}
