import type { CollectionConfig } from 'payload'

import { restrictedSlug, usersSlug } from '../../slugs.js'

export const RestrictedCollection: CollectionConfig = {
  slug: restrictedSlug,
  access: {
    // Admins update every document, other users only the documents they own
    update: ({ req: { user } }) => {
      if (!user) {
        return false
      }

      return user.roles?.includes('is_admin') ? true : { owner: { equals: user.id } }
    },
  },
  admin: {
    useAsTitle: 'text',
  },
  fields: [
    {
      name: 'text',
      type: 'text',
    },
    {
      name: 'owner',
      type: 'relationship',
      relationTo: usersSlug,
    },
  ],
}
