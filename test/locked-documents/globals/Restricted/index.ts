import type { GlobalConfig } from 'payload'

export const restrictedGlobalSlug = 'restricted-global'

export const RestrictedGlobal: GlobalConfig = {
  slug: restrictedGlobalSlug,
  access: {
    update: ({ req: { user } }) => Boolean(user?.roles?.includes('is_admin')),
  },
  fields: [
    {
      name: 'text',
      type: 'text',
    },
  ],
}
