/** Roles are application policy; adapters only encode their provider representation. */
export const ROLES = [
  'Director',
  'Builder',
  'Reviewer: correctness',
  'Reviewer: security',
  'Reviewer: testing',
  'Reviewer: operations',
  'Reviewer: product',
  'Judge',
  'Owner decides',
  'Owner verifies',
  'Owner operates',
] as const;
export type Role = (typeof ROLES)[number];

/** The canonical spelling of a role, or undefined for a value outside the list, such as one a project added. */
export function canonicalRole(value: string): Role | undefined {
  return ROLES.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
}

/** Resolve CLI or integration input against the same canonical role list. */
export function roleOf(value: string): Role {
  const role = canonicalRole(value);
  if (!role) throw new Error(`unknown Role "${value}"; one of: ${ROLES.join(' | ')}`);
  return role;
}

/** Owner roles require human action, so take must not silently claim them. */
export function isOwnerRole(role: string): boolean {
  return ['Owner decides', 'Owner verifies', 'Owner operates'].includes(role);
}
