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

/**
 * The film roles (YA-43): an optional set for a project that makes films. A film is planned by a Producer and read
 * by six reviewers of its own; Builder, Judge and the Owner roles serve films as they are. All seven are agent
 * roles. They are accepted wherever a role is, but they are not part of the Role field every adopting project
 * creates (ADOPTING.md): a project that makes films adds them to its own field.
 */
export const FILM_ROLES = [
  'Producer',
  'Reviewer: script',
  'Reviewer: picture',
  'Reviewer: sound',
  'Reviewer: access',
  'Reviewer: production',
  'Reviewer: audience',
] as const;

/** Every role the tool accepts: the canonical list, then the optional sets. */
export const ALL_ROLES = [...ROLES, ...FILM_ROLES] as const;
export type Role = (typeof ALL_ROLES)[number];

/** The canonical spelling of a role, or undefined for a value outside the lists, such as one a project added. */
export function canonicalRole(value: string): Role | undefined {
  return ALL_ROLES.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
}

/** Resolve CLI or integration input against the same role lists. */
export function roleOf(value: string): Role {
  const role = canonicalRole(value);
  if (!role) throw new Error(`unknown Role "${value}"; one of: ${ALL_ROLES.join(' | ')}`);
  return role;
}

/** Owner roles require human action, so take must not silently claim them. */
export function isOwnerRole(role: string): boolean {
  return ['Owner decides', 'Owner verifies', 'Owner operates'].includes(role);
}
