/**
 * Role and capability definitions, shared verbatim by client and server.
 *
 * This table is the only place authorization is described. The client imports it to
 * decide which controls to enable, the server imports it to enforce the same rules,
 * and the matrix in docs/06-auth-and-permissions.md renders it rather than restating
 * it. `can()` is deliberately a data lookup and nothing more: a permission check that
 * can be expressed as a membership test must not be a chain of `if (role === ...)`
 * branches, because those drift.
 *
 * See docs/06-auth-and-permissions.md (Role matrix) and
 * docs/adr/0001-authorization-model.md.
 */

export const ROLES = ['owner', 'editor', 'commenter', 'viewer'] as const
export type Role = (typeof ROLES)[number]

/**
 * `<resource>.<action>`, with the resource's own verb meaning "any update to it".
 * `write` is the document-update capability, not a specific shape operation.
 */
export const CAPABILITIES = [
  'read',
  'presence',
  'write',
  'undo',
  'upload',
  'version.read',
  'version.create',
  'version.restore',
  'share.manage',
  'board.write',
  'board.delete',
  'comment.write',
  'comment.resolve',
  'export',
] as const
export type Capability = (typeof CAPABILITIES)[number]

const GRANTS = {
  owner: [
    'read',
    'presence',
    'write',
    'undo',
    'upload',
    'version.read',
    'version.create',
    'version.restore',
    'share.manage',
    'board.write',
    'board.delete',
    'comment.write',
    'comment.resolve',
    'export',
  ],
  editor: [
    'read',
    'presence',
    'write',
    'undo',
    'upload',
    'version.read',
    'version.create',
    'comment.write',
    'comment.resolve',
    'export',
  ],
  // Comments are a table, not document content, so Commenter writes comments and
  // nothing else. If comments were doc content, Commenter would be Editor.
  commenter: ['read', 'presence', 'version.read', 'comment.write', 'export'],
  // Viewer can export: an export is a read, and blocking it is a surprising
  // restriction on a read-only user.
  viewer: ['read', 'presence', 'version.read', 'export'],
} as const satisfies Record<Role, readonly Capability[]>

/** Every capability `role` holds. */
export function capabilitiesFor(role: Role): readonly Capability[] {
  return GRANTS[role]
}

/** Whether `role` holds `cap`. The single authorization predicate. */
export function can(role: Role, cap: Capability): boolean {
  return (GRANTS[role] as readonly string[]).includes(cap)
}
