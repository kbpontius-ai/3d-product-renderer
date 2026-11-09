import type { ConfirmOptions } from '@/components/confirm-dialog';

/**
 * What a change to somebody's access means, in words, before it is made (F-ADM-06, F-ORG-02).
 *
 * One click on a role select once took a staff member out of the admin console mid-session: `staff`
 * and `owner` are values of the same column, so making yourself an organisation's owner stopped you
 * being staff, and nothing said so. Every change to what a person can reach now goes through here,
 * so both consoles say the same thing and the wording is tested once.
 */

export type AccessRole = 'staff' | 'owner' | 'member';

export type AccessChange =
  | { kind: 'role'; from: AccessRole; to: AccessRole }
  | { kind: 'suspend' }
  | { kind: 'restore' }
  | { kind: 'delete' }
  | { kind: 'revoke-invitation' };

export interface AccessSubject {
  email: string;
  /** The organisation they belong to, for "can manage people in …". */
  orgName?: string;
}

const STAFF_REACH = 'every organization, every account, packs, materials, CAD and the render queue';

export function describeAccessChange(change: AccessChange, who: AccessSubject): ConfirmOptions {
  const org = who.orgName ?? 'their organization';

  switch (change.kind) {
    case 'role': {
      const consequences: string[] = [];
      if (change.to === 'staff') {
        consequences.push(`They get the admin console: ${STAFF_REACH}.`);
      }
      if (change.from === 'staff') {
        consequences.push('They lose the admin console immediately, including any page they have open.');
      }
      if (change.to === 'owner') {
        consequences.push(`They can invite, suspend and change the role of anyone in ${org}.`);
      }
      if (change.from === 'owner') {
        consequences.push(`They can no longer manage the people in ${org}.`);
      }
      if (change.to === 'member') {
        consequences.push('They keep their designs and can still design and render.');
      }
      const losing = change.from === 'staff' || (change.from === 'owner' && change.to === 'member');
      return {
        title: `Change ${who.email} from ${change.from} to ${change.to}?`,
        ...(change.from === 'staff'
          ? { body: ['Staff and organization roles are one setting: an account is staff, an owner or a member, never two.'] }
          : {}),
        consequences,
        confirmLabel: `Make ${change.to}`,
        tone: losing ? 'danger' : 'default',
      };
    }
    case 'suspend':
      return {
        title: `Suspend ${who.email}?`,
        consequences: [
          'They are signed out everywhere, at once.',
          'They cannot sign in until the account is restored.',
          'Their designs and renders are kept.',
        ],
        confirmLabel: 'Suspend',
        tone: 'danger',
      };
    case 'restore':
      return {
        title: `Restore ${who.email}?`,
        consequences: ['They can sign in again with their existing password.', 'Everything they had is as they left it.'],
        confirmLabel: 'Restore access',
        tone: 'default',
      };
    case 'delete':
      return {
        title: `Delete ${who.email}?`,
        consequences: [
          'The account is removed permanently. This cannot be undone.',
          `Their designs, renders and artwork stay with ${org}.`,
        ],
        confirmLabel: 'Delete account',
        tone: 'danger',
      };
    case 'revoke-invitation':
      return {
        title: `Revoke the invitation to ${who.email}?`,
        consequences: ['The link they were sent stops working.', 'You can invite them again later.'],
        confirmLabel: 'Revoke invitation',
        tone: 'danger',
      };
  }
}
