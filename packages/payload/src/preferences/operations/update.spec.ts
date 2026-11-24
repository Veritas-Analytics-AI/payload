import { describe, expect, it, vi } from 'vitest'

import type { PayloadRequest } from '../../types/index.js'

import {
  MAX_PREFERENCE_KEY_LENGTH,
  MAX_PREFERENCE_VALUE_BYTES,
  MAX_PREFERENCES_PER_USER,
} from '../config.js'
import { update } from './update.js'

// `owned` preferences, of which `withKey` have the key being written
const withPreferences = ({ owned, withKey }: { owned: number; withKey: number }) => {
  const count = vi.fn(({ where }) => ({ totalDocs: where.and.length === 3 ? withKey : owned }))
  const upsert = vi.fn(({ data }) => data)
  const req = {
    payload: { db: { count, upsert } },
    t: (key: string) => key,
  } as unknown as PayloadRequest

  return { req, upsert, user: { id: 1, collection: 'users' } as unknown as PayloadRequest['user'] }
}

describe('update preference', () => {
  it('should refuse a value over the size limit, and write nothing', async () => {
    const { req, upsert, user } = withPreferences({ owned: 0, withKey: 0 })

    await expect(
      update({ key: 'nav', req, user, value: 'x'.repeat(MAX_PREFERENCE_VALUE_BYTES) }),
    ).rejects.toMatchObject({ status: 413 })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('should refuse a key that is not a short string', async () => {
    const { req, user } = withPreferences({ owned: 0, withKey: 0 })

    for (const key of ['', 'k'.repeat(MAX_PREFERENCE_KEY_LENGTH + 1), undefined]) {
      await expect(update({ key: key as string, req, user, value: 1 })).rejects.toMatchObject({
        status: 400,
      })
    }
  })

  it('should refuse a new key once the user holds the most preferences, but update an existing one', async () => {
    const full = withPreferences({ owned: MAX_PREFERENCES_PER_USER, withKey: 0 })

    await expect(
      update({ key: 'new', req: full.req, user: full.user, value: 1 }),
    ).rejects.toMatchObject({ status: 429 })
    expect(full.upsert).not.toHaveBeenCalled()

    const existing = withPreferences({ owned: MAX_PREFERENCES_PER_USER, withKey: 1 })

    await update({ key: 'nav', req: existing.req, user: existing.user, value: 1 })
    expect(existing.upsert).toHaveBeenCalledOnce()
  })
})
