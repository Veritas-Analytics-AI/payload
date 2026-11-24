import type { Where } from '../../types/index.js'
import type { PreferenceUpdateRequest } from '../types.js'

import { APIError } from '../../errors/APIError.js'
import { UnauthorizedError } from '../../errors/UnauthorizedError.js'
import {
  isPreferenceValueTooLarge,
  MAX_PREFERENCE_KEY_LENGTH,
  MAX_PREFERENCES_PER_USER,
  preferencesCollectionSlug,
} from '../config.js'

export async function update(args: PreferenceUpdateRequest) {
  const {
    key,
    req: { payload },
    req,
    user,
    value,
  } = args

  if (!user) {
    throw new UnauthorizedError(req.t)
  }

  // The upsert below skips the collection's field validation, so its bounds are checked here
  if (typeof key !== 'string' || !key || key.length > MAX_PREFERENCE_KEY_LENGTH) {
    throw new APIError('Invalid preference key.', 400)
  }

  if (isPreferenceValueTooLarge(value)) {
    throw new APIError('Preference value too large.', 413)
  }

  const owner: Where[] = [
    { 'user.value': { equals: user.id } },
    { 'user.relationTo': { equals: user.collection } },
  ]

  const where: Where = {
    and: [{ key: { equals: key } }, ...owner],
  }

  // Concurrent requests for new keys can each pass this count, so a user can go over the limit by
  // as many requests as they send at once
  const { totalDocs: existing } = await payload.db.count({
    collection: preferencesCollectionSlug,
    req,
    where,
  })

  if (!existing) {
    const { totalDocs } = await payload.db.count({
      collection: preferencesCollectionSlug,
      req,
      where: { and: owner },
    })

    if (totalDocs >= MAX_PREFERENCES_PER_USER) {
      throw new APIError('Too many preferences.', 429)
    }
  }

  const preference = {
    key,
    user: {
      relationTo: user.collection,
      value: user.id,
    },
    value,
  }

  return await payload.db.upsert({
    collection: preferencesCollectionSlug,
    data: preference,
    req,
    where,
  })
}
