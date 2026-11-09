import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReservedRecipient, refuseReservedRecipients } from './reserved.js';
import { mailerFromEnv } from './from-env.js';
import type { Mailer, MailMessage } from './mailer.js';

describe('reserved recipients', () => {
  it.each([
    'e2e-1a2b@example.com',
    'someone@EXAMPLE.COM',
    'a@mail.example.org',
    'a@example.net',
    'owner@alpha.test',
    'x@nowhere.invalid',
    'x@machine.localhost',
    'x@docs.example',
    'x@example.com.',
  ])('refuses %s', (address) => {
    expect(isReservedRecipient(address)).toBe(true);
  });

  it.each([
    'kyle@kylepontius.com',
    'someone@gmail.com',
    // Near misses: a suffix match without the dot would catch these, and they are real domains.
    'a@notexample.com',
    'a@example.co',
    'a@test.com',
    'no-at-sign',
  ])('allows %s', (address) => {
    expect(isReservedRecipient(address)).toBe(false);
  });
});

describe('the guard around a transport', () => {
  const message = (to: string): MailMessage => ({ to, template: 'invite', vars: { url: 'https://x.test/i' } });

  it('never hands a reserved address to the transport', async () => {
    const inner: Mailer = { send: vi.fn(async () => {}) };
    const result = await refuseReservedRecipients(inner).send(message('e2e-user@example.com'));
    expect(inner.send).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: false, reason: 'reserved_recipient' });
  });

  it('passes a real address through untouched', async () => {
    const inner: Mailer = { send: vi.fn(async () => {}) };
    await refuseReservedRecipients(inner).send(message('kyle@kylepontius.com'));
    expect(inner.send).toHaveBeenCalledOnce();
  });
});

/**
 * The property that matters, checked on the transport a process actually gets.
 *
 * This is the regression: with a real key in the shell, the end-to-end suite's server built this
 * mailer and sent every `@example.com` invitation and reset to the provider.
 */
describe('a transport built from a configured environment', () => {
  afterEach(() => vi.unstubAllGlobals());

  const configured = { RESEND_API_KEY: 're_test', MAIL_FROM: 'Test <no-reply@kylepontius.com>' };

  it('makes no request at all for a reserved recipient', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await mailerFromEnv(configured).send({ to: 'e2e-user@example.com', template: 'invite', vars: {} });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still sends to a real recipient, and says it did', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await mailerFromEnv(configured).send({
      to: 'kyle@kylepontius.com',
      template: 'invite',
      vars: { url: 'https://renderer.kylepontius.com/invite/accept?token=t' },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toEqual({ delivered: true });
  });
});
