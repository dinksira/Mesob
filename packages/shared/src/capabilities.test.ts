import { describe, expect, it } from 'vitest'
import { CAPABILITIES, ROLES, can, capabilitiesFor } from './capabilities.js'

describe('capabilities', () => {
  it('grants every role the read capabilities', () => {
    for (const role of ROLES) {
      expect(can(role, 'read')).toBe(true)
      expect(can(role, 'presence')).toBe(true)
    }
  })

  it('lets every role export, since export is a read', () => {
    for (const role of ROLES) expect(can(role, 'export')).toBe(true)
  })

  it('never grants document writes to commenter or viewer', () => {
    expect(can('commenter', 'write')).toBe(false)
    expect(can('viewer', 'write')).toBe(false)
  })

  it('keeps comment writes separate from document writes', () => {
    expect(can('commenter', 'comment.write')).toBe(true)
    expect(can('commenter', 'comment.resolve')).toBe(false)
    expect(can('editor', 'comment.resolve')).toBe(true)
  })

  it('reserves version restore for the owner', () => {
    // Restoring rewrites visible state for everyone, including other editors' work.
    for (const role of ROLES) {
      expect(can(role, 'version.restore')).toBe(role === 'owner')
    }
  })

  it('reserves board deletion for the owner', () => {
    for (const role of ROLES) expect(can(role, 'board.delete')).toBe(role === 'owner')
  })

  it('grants editors version creation but not restore', () => {
    expect(can('editor', 'version.create')).toBe(true)
    expect(can('editor', 'version.restore')).toBe(false)
  })

  it('grants only the owner share management', () => {
    for (const role of ROLES) expect(can(role, 'share.manage')).toBe(role === 'owner')
  })

  it('only names capabilities from the declared union', () => {
    const known = new Set<string>(CAPABILITIES)
    for (const role of ROLES) {
      for (const cap of capabilitiesFor(role)) expect(known.has(cap)).toBe(true)
    }
  })
})
