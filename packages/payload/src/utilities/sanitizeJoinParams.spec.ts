import { describe, expect, it } from 'vitest'

import { sanitizeJoinParams } from './sanitizeJoinParams.js'

describe('sanitizeJoinParams', () => {
  it('should disable every join with a top-level false', () => {
    expect(sanitizeJoinParams(false)).toBe(false)
  })

  it('should disable every join with a top-level false from a query string', () => {
    expect(sanitizeJoinParams('false')).toBe(false)
  })
})
