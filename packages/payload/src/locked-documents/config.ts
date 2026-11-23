import type { CollectionConfig, TypeWithID } from '../collections/config/types.js'
import type { Access, Config } from '../config/types.js'
import type { JsonObject } from '../types/index.js'

import { canLockDocument } from './canLockDocument.js'

export const lockedDocumentsCollectionSlug = 'payload-locked-documents'

// A user reads, changes and deletes the locks of the documents and globals they may update. That
// depends on each locked document, so the locks are read to answer with the ones permitted.
const readAccess: Access = async ({ id, req }) => {
  if (!req.user) {
    return false
  }

  const { docs: locks } = await req.payload.db.find<JsonObject & TypeWithID>({
    collection: lockedDocumentsCollectionSlug,
    pagination: false,
    req,
    where: id ? { id: { equals: id } } : {},
  })

  const permittedLockIDs: (number | string)[] = []

  for (const lock of locks) {
    const canLock = await canLockDocument({
      id: lock.document?.value,
      collectionSlug: lock.document?.relationTo,
      globalSlug: lock.globalSlug,
      req,
    })

    if (canLock) {
      permittedLockIDs.push(lock.id)
    }
  }

  return { id: { in: permittedLockIDs } }
}

// A lock is changed or deleted by its ID, which is all the admin does. A change of several locks
// is refused: a user's permissions are built by calling each access function without an ID, and
// this keeps that to one read of the locks.
const changeAccess: Access = (args) => (args.id ? readAccess(args) : false)

export const getLockedDocumentsCollection = (config: Config): CollectionConfig | null => {
  const lockableCollections = config
    .collections!.filter((collectionConfig) => collectionConfig.lockDocuments !== false)
    .map((collectionConfig) => collectionConfig.slug)

  const lockableGlobals = config.globals
    ? config.globals.filter((globalConfig) => globalConfig.lockDocuments !== false)
    : []

  const authCollections = config
    .collections!.filter((collectionConfig) => collectionConfig.auth)
    .map((collectionConfig) => collectionConfig.slug)

  // If there are no lockable collections AND no lockable globals, don't create the collection
  if (lockableCollections.length === 0 && lockableGlobals.length === 0) {
    return null
  }

  // If there are no auth collections, we can't track who locked the document
  // so we shouldn't create the locked-documents collection
  if (authCollections.length === 0) {
    return null
  }

  const fields: CollectionConfig['fields'] = []

  // Only include the document field if there are lockable collections
  if (lockableCollections.length > 0) {
    fields.push({
      name: 'document',
      type: 'relationship',
      access: {
        update: () => false,
      },
      index: true,
      maxDepth: 0,
      relationTo: lockableCollections,
    })
  }

  // Always include globalSlug field for tracking global locks
  fields.push({
    name: 'globalSlug',
    type: 'text',
    access: {
      update: () => false,
    },
    index: true,
  })

  // Always include user field
  fields.push({
    name: 'user',
    type: 'relationship',
    hooks: {
      beforeValidate: [
        // A change made with access control names its own user: a lock is only taken over
        ({ overrideAccess, req, value }) =>
          overrideAccess || !req.user
            ? value
            : { relationTo: req.user.collection, value: req.user.id },
      ],
    },
    maxDepth: 1,
    relationTo: authCollections,
    required: true,
  })

  return {
    slug: lockedDocumentsCollectionSlug,
    access: {
      // Locks are created on the server, by the form state of a document being edited
      create: () => false,
      delete: changeAccess,
      read: readAccess,
      update: changeAccess,
    },
    admin: {
      hidden: true,
    },
    fields,
    lockDocuments: false,
  }
}
