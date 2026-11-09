import { describe, expect, it, vi } from 'vitest';
import { escapeHtml, renderMail, templateNames } from './templates.js';
import { logMailer, resendMailer } from './resend.js';
import { mailerFromEnv } from './from-env.js';

describe('templates', () => {
  it('renders every template it claims to know', () => {
    for (const name of templateNames()) {
      const mail = renderMail({
        template: name,
        vars: { url: 'https://example.com/go?token=abc', expiresAt: '2026-01-01T00:00:00.000Z', seconds: 120 },
      });
      expect(mail.subject, name).toBeTruthy();
      expect(mail.html, name).toContain('<html');
      // A body with no text alternative scores worse with spam filters, and these are the messages
      // that have to arrive.
      expect(mail.text.length, name).toBeGreaterThan(0);
      expect(mail.text, name).toContain('https://example.com/go?token=abc');
    }
  });

  it('knows the four templates that have call sites', () => {
    expect(templateNames()).toEqual(['invite', 'password-reset', 'render-ready', 'render-failed'].sort());
  });

  it('refuses a template it does not have, rather than sending a blank message', () => {
    expect(() => renderMail({ template: 'nope', vars: {} })).toThrow(/no mail template/);
  });

  /**
   * The one property that matters. `F-REND-14` will put a design name in one of these bodies, and a
   * design name is whatever a customer typed into the editor.
   */
  it('never lets a variable become markup', () => {
    const mail = renderMail({
      template: 'render-failed',
      vars: { url: 'https://example.com/d/1', body: '<script>alert(1)</script>' },
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('drops a link that is not http(s) instead of rendering it', () => {
    const mail = renderMail({ template: 'invite', vars: { url: 'javascript:alert(1)' } });
    expect(mail.html).not.toContain('javascript:');
  });

  it('escapes the characters that matter', () => {
    expect(escapeHtml(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&#39;');
  });
});

describe('the resend transport', () => {
  const ok = () => new Response('{"id":"1"}', { status: 200 });

  it('posts a rendered message with a bearer token', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ok());
    await resendMailer({ apiKey: 'k', from: 'A <a@example.com>', fetch: fetch as never }).send({
      to: 'b@example.com',
      template: 'invite',
      vars: { url: 'https://example.com/i?token=t' },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['from']).toBe('A <a@example.com>');
    expect(body['to']).toEqual(['b@example.com']);
    expect(body['subject']).toBeTruthy();
    expect(body['html']).toContain('https://example.com/i?token=t');
    expect(body['text']).toContain('https://example.com/i?token=t');
    expect(body).not.toHaveProperty('reply_to');
  });

  it('carries an inline attachment as base64 with a content id', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ok());
    await resendMailer({ apiKey: 'k', from: 'a@example.com', fetch: fetch as never }).send({
      to: 'b@example.com',
      template: 'render-ready',
      vars: { url: 'https://example.com/r/1' },
      attachments: [
        { filename: 'preview.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]), cid: 'preview' },
      ],
    });

    const init = fetch.mock.calls[0]![1];
    const body = JSON.parse(String(init.body)) as { attachments: Record<string, string>[] };
    expect(body.attachments[0]).toEqual({
      filename: 'preview.png',
      content: Buffer.from([1, 2, 3]).toString('base64'),
      content_type: 'image/png',
      content_id: 'preview',
    });
  });

  it('includes a reply-to only when one is configured', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ok());
    await resendMailer({ apiKey: 'k', from: 'a@example.com', replyTo: 'r@example.com', fetch: fetch as never }).send({
      to: 'b@example.com',
      template: 'invite',
      vars: { url: 'https://example.com/i' },
    });
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as Record<string, unknown>;
    expect(body['reply_to']).toBe('r@example.com');
  });

  it('reports why the API refused, because that is the difference between broken and misconfigured', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response('{"message":"domain is not verified"}', { status: 403 }),
    );
    const mailer = resendMailer({ apiKey: 'k', from: 'a@example.com', fetch: fetch as never });

    await expect(
      mailer.send({ to: 'b@example.com', template: 'invite', vars: { url: 'https://example.com/i' } }),
    ).rejects.toThrow(/403.*domain is not verified/);
  });
});

describe('choosing a mailer from the environment', () => {
  it('logs rather than throws when nothing is configured', async () => {
    const mailer = mailerFromEnv({});
    expect(mailer).toBe(logMailer);
    // The property that matters: it resolves. A throwing fallback is what made a password reset
    // answer differently for an address that existed. It also says nothing left, so an invitation
    // made with no provider configured is never reported as emailed.
    await expect(mailer.send({ to: 'a@example.com', template: 'invite', vars: {} })).resolves.toEqual({
      delivered: false,
      reason: 'no_provider',
    });
  });

  it('refuses to half-configure: a key with no sender sends nothing', () => {
    expect(mailerFromEnv({ RESEND_API_KEY: 'k' })).toBe(logMailer);
  });

  it('builds a real transport when both are set', () => {
    const mailer = mailerFromEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@example.com' });
    expect(mailer).not.toBe(logMailer);
  });

  it('treats whitespace as unset, because a blank line in an env file is not configuration', () => {
    expect(mailerFromEnv({ RESEND_API_KEY: '  ', MAIL_FROM: 'a@example.com' })).toBe(logMailer);
  });
});
