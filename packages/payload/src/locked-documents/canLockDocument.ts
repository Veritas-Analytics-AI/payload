import type { PayloadRequest } from '../types/index.js'

import { executeAccess } from '../auth/executeAccess.js'
import { entityDocExists } from '../utilities/getEntityPermissions/entityDocExists.js'

type Args = {
  collectionSlug?: string
  globalSlug?: string
  id?: number | string
  req: PayloadRequest
}

/**
 * Returns whether the user of the request may update the document or global. A lock is held,
 * read, changed and deleted only by a user who may.
 */
export const canLockDocument = async ({
  id,
  collectionSlug,
  globalSlug,
  req,
}: Args): Promise<boolean> => {
  const entityConfig = collectionSlug
    ? req.payload.collections[collectionSlug]?.config
    : req.payload.config.globals.find(({ slug }) => slug === globalSlug)

  if (!entityConfig) {
    return false
  }

  const accessResult = await executeAccess(
    { id, disableErrors: true, req },
    entityConfig.access.update,
  )

  if (typeof accessResult === 'object') {
    return entityDocExists({
      id,
      slug: entityConfig.slug,
      entityType: collectionSlug ? 'collection' : 'global',
      req,
      where: accessResult,
    })
  }

  return Boolean(accessResult)
}
