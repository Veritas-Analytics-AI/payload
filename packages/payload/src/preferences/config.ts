import type { CollectionConfig } from '../collections/config/types.js'
import type { Access, Config } from '../config/types.js'
import type { Where } from '../types/index.js'

import { deleteHandler } from './requestHandlers/delete.js'
import { findByIDHandler } from './requestHandlers/findOne.js'
import { updateHandler } from './requestHandlers/update.js'

export const MAX_PREFERENCE_KEY_LENGTH = 256

export const MAX_PREFERENCE_VALUE_BYTES = 256 * 1024

export const MAX_PREFERENCES_PER_USER = 5000

export const isPreferenceValueTooLarge = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null)) > MAX_PREFERENCE_VALUE_BYTES

const preferenceAccess: Access = ({ req }) => {
  if (!req.user) {
    return false
  }

  const userValueCondition: Where = {
    'user.value': {
      equals: req.user.id,
    },
  }

  const userRelationCondition: Where = {
    'user.relationTo': {
      equals: req.user.collection,
    },
  }

  return {
    and: [userValueCondition, userRelationCondition],
  }
}

export const preferencesCollectionSlug = 'payload-preferences'

export const getPreferencesCollection = (config: Config): CollectionConfig => ({
  slug: preferencesCollectionSlug,
  access: {
    // A preference is created by the /:key endpoint, which bounds it, or on the server
    create: () => false,
    delete: preferenceAccess,
    read: preferenceAccess,
    update: preferenceAccess,
  },
  admin: {
    hidden: true,
  },
  endpoints: [
    {
      handler: findByIDHandler,
      method: 'get',
      path: '/:key',
    },
    {
      handler: deleteHandler,
      method: 'delete',
      path: '/:key',
    },
    {
      handler: updateHandler,
      method: 'post',
      path: '/:key',
    },
  ],
  fields: [
    {
      name: 'user',
      type: 'relationship',
      hooks: {
        beforeValidate: [
          ({ req }) => {
            if (!req?.user) {
              return null
            }

            return {
              relationTo: req?.user.collection,
              value: req?.user.id,
            }
          },
        ],
      },
      index: true,
      relationTo: config
        .collections!.filter((collectionConfig) => collectionConfig.auth)
        .map((collectionConfig) => collectionConfig.slug),
      required: true,
    },
    {
      name: 'key',
      type: 'text',
      index: true,
      maxLength: MAX_PREFERENCE_KEY_LENGTH,
    },
    {
      name: 'value',
      type: 'json',
      validate: (value) => {
        if (value) {
          try {
            if (isPreferenceValueTooLarge(value)) {
              return 'Preference value too large'
            }
          } catch {
            return 'Invalid JSON'
          }
        }

        return true
      },
    },
  ],
  lockDocuments: false,
})
