import { describe, expect, it } from 'vitest'

import type { PayloadRequest } from '../types/index.js'

import { canLockDocument } from './canLockDocument.js'

describe('canLockDocument', () => {
  it('should refuse when the update access returns null', async () => {
    const req = {
      payload: {
        collections: { posts: { config: { slug: 'posts', access: { update: () => null } } } },
        db: { count: () => ({ totalDocs: 1 }) },
      },
      user: { id: 1 },
    } as unknown as PayloadRequest

    expect(await canLockDocument({ id: 1, collectionSlug: 'posts', req })).toBe(false)
  })
})
