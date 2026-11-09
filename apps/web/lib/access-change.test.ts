import { describe, expect, it } from 'vitest';
import { describeAccessChange } from './access-change';

/** What each access change says before it is made — the wording both consoles share. */

const who = { email: 'pat@example.com', orgName: 'Demo Organisation' };
const text = (o: ReturnType<typeof describeAccessChange>) => [o.title, ...(o.body ?? []), ...(o.consequences ?? [])].join(' ');

describe('describing an access change', () => {
  it('warns a staff member is about to lose the console — the change that locked someone out', () => {
    const change = describeAccessChange({ kind: 'role', from: 'staff', to: 'owner' }, who);
    expect(change.tone).toBe('danger');
    expect(change.title).toBe('Change pat@example.com from staff to owner?');
    expect(text(change)).toContain('lose the admin console immediately');
    expect(text(change)).toContain('never two');
    expect(text(change)).toContain('anyone in Demo Organisation');
    expect(change.confirmLabel).toBe('Make owner');
  });

  it('says what granting staff gives', () => {
    const change = describeAccessChange({ kind: 'role', from: 'member', to: 'staff' }, who);
    expect(change.tone).toBe('default');
    expect(text(change)).toContain('every organization, every account');
  });

  it('treats owner to member as taking something away, and member to owner as giving', () => {
    const down = describeAccessChange({ kind: 'role', from: 'owner', to: 'member' }, who);
    expect(down.tone).toBe('danger');
    expect(text(down)).toContain('no longer manage the people in Demo Organisation');
    expect(text(down)).toContain('keep their designs');

    const up = describeAccessChange({ kind: 'role', from: 'member', to: 'owner' }, who);
    expect(up.tone).toBe('default');
    expect(text(up)).not.toContain('no longer');
  });

  it('spells out suspension, restoration, deletion and revocation', () => {
    expect(text(describeAccessChange({ kind: 'suspend' }, who))).toContain('signed out everywhere');
    expect(describeAccessChange({ kind: 'restore' }, who).tone).toBe('default');
    const del = describeAccessChange({ kind: 'delete' }, who);
    expect(del).toMatchObject({ tone: 'danger', confirmLabel: 'Delete account' });
    expect(text(del)).toContain('cannot be undone');
    expect(text(del)).toContain('stay with Demo Organisation');
    expect(text(describeAccessChange({ kind: 'revoke-invitation' }, { email: 'x@example.com' }))).toContain(
      'stops working',
    );
  });

  it('says "their organization" when it does not know which', () => {
    expect(text(describeAccessChange({ kind: 'delete' }, { email: 'x@example.com' }))).toContain('their organization');
  });
});
