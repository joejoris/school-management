/**
 * Who may do what.
 *
 * One table, in one place, read by the server and by nothing else. The point of
 * putting it here rather than in a screen is that a check in the interface is a
 * check the person using the computer can delete — it protects the appearance of
 * a rule, not the rule.
 *
 * `anonymous` is in the list deliberately and is granted **nothing**. That is
 * what "signed out" means: not a reduced version of an account, but no
 * permissions at all. If the default were some permissive role, forgetting to
 * check one method would be silently exploitable.
 */

import type { Role } from './enums.ts'

export type Permission =
  | 'titles.read'
  | 'titles.write'
  | 'copies.read'
  | 'copies.write'
  | 'members.read'
  | 'members.write'
  | 'loans.read'
  | 'loans.checkout'
  | 'loans.return'
  | 'loans.void'
  | 'loans.renew'
  | 'fines.read'
  | 'fines.write'
  | 'holds.read'
  | 'holds.write'
  | 'reports.run'
  | 'imports.run'
  | 'settings.read'
  | 'settings.write'
  | 'users.read'
  | 'users.write'
  | 'audit.read'

/** Everything an administrator may do. */
const ADMIN: readonly Permission[] = [
  'titles.read',
  'titles.write',
  'copies.read',
  'copies.write',
  'members.read',
  'members.write',
  'loans.read',
  'loans.checkout',
  'loans.return',
  'loans.void',
  'loans.renew',
  'fines.read',
  'fines.write',
  'holds.read',
  'holds.write',
  'reports.run',
  'imports.run',
  'settings.read',
  'settings.write',
  'users.read',
  'users.write',
  'audit.read',
]

/**
 * Everything an assistant may do.
 *
 * The shape of the job: issue books, take them back, work the register, read
 * fines. What they cannot do is change the rules or touch accounts — those are
 * the two that a shared desk should not have lying around.
 */
const ASSISTANT: readonly Permission[] = [
  'titles.read',
  'copies.read',
  'members.read',
  'loans.read',
  'loans.checkout',
  'loans.return',
  'loans.void',
  'loans.renew',
  'fines.read',
  'holds.read',
]

/** A teacher who borrows. Read-only: they are a member, not staff. */
const TEACHER: readonly Permission[] = ['titles.read', 'copies.read', 'members.read', 'loans.read']

export const PERMISSIONS: Record<Role | 'anonymous', ReadonlySet<Permission>> = {
  admin: new Set(ADMIN),
  assistant: new Set(ASSISTANT),
  teacher: new Set(TEACHER),
  // Nothing. Not a reduced set — an empty one.
  anonymous: new Set<Permission>(),
}

export function can(role: Role | 'anonymous', permission: Permission): boolean {
  return PERMISSIONS[role].has(permission)
}

/** The refusal, phrased for a person rather than a log. */
export function deny(role: Role | 'anonymous', permission: Permission): Error {
  return new Error(
    role === 'anonymous'
      ? 'Sign in to do that.'
      : `Your role (${role}) cannot ${permission.replace('.', ' ')}.`,
  )
}

/**
 * `assistant` is the role that exists because this is a school.
 *
 * Worth naming: it is not a lesser admin, it is the job. Almost everything in
 * this system is issuing and returning books, and the only things it cannot do
 * are change the rules and manage accounts.
 */
export const PRIMARY_DESK_ROLE = 'assistant' as const