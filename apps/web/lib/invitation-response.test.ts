import { describe, expect, it } from 'vitest';
import { invitationResponse } from './invitation-response';

describe('invitationResponse', () => {
  const sent = { email: 'new@acme.co', token: 'secret-token', delivery: { delivered: true } as const };

  it('never hands the inviter the link outside development', () => {
    // The link in the inviter's hands lets them accept for somebody else, so acceptance would no
    // longer prove the invitee owns the mailbox.
    const response = invitationResponse(sent, { appUrl: 'https://app.example', exposeLink: false });
    expect(response).toEqual({ email: 'new@acme.co', delivered: true });
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });

  it('includes the link where development tooling is on', () => {
    expect(invitationResponse(sent, { appUrl: 'http://localhost:3000/', exposeLink: true }).url).toBe(
      'http://localhost:3000/invite/accept?token=secret-token',
    );
  });

  it('says why no email went, rather than claiming it was sent', () => {
    for (const reason of ['no_provider', 'reserved_recipient', 'captured', 'failed'] as const) {
      const response = invitationResponse(
        { ...sent, delivery: { delivered: false, reason } },
        { appUrl: 'https://app.example', exposeLink: false },
      );
      expect(response.delivered).toBe(false);
      expect(response.notDelivered).toMatch(/\w/);
    }
  });
});
