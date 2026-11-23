import type { PostgresAdapter } from '@payloadcms/db-postgres'
import type {
  Payload,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
} from 'payload'

import path from 'path'
import { buildFormState } from '@payloadcms/ui/utilities/buildFormState'
import { createLocalReq, Locked, NotFound } from 'payload'
import { wait } from 'payload/shared'
import { fileURLToPath } from 'url'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'

import type { NextRESTClient } from '../__helpers/shared/NextRESTClient.js'
import type { Post, Restricted, User } from './payload-types.js'

import { describe, it } from '../__helpers/int/vitest.js'
import { initPayloadInt } from '../__helpers/shared/initPayloadInt.js'
import { devUser, regularUser } from '../credentials.js'
import { menuSlug } from './globals/Menu/index.js'
import { restrictedGlobalSlug } from './globals/Restricted/index.js'
import { pagesSlug, postsSlug, restrictedSlug, simpleSlug, usersSlug } from './slugs.js'

const lockedDocumentCollection = 'payload-locked-documents'

let payload: Payload
let restClient: NextRESTClient

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

describe('Locked documents', () => {
  let post: Post
  let user: any
  let user2: any
  let postConfig: SanitizedCollectionConfig

  beforeAll(async () => {
    // @ts-expect-error: initPayloadInt does not have a proper type definition
    ;({ payload, restClient } = await initPayloadInt(dirname))

    postConfig = payload.config.collections.find(
      ({ slug }) => slug === postsSlug,
    ) as SanitizedCollectionConfig

    const loginResult = await payload.login({
      collection: 'users',
      data: {
        email: devUser.email,
        password: devUser.password,
      },
    })

    user = loginResult.user

    user2 = await payload.create({
      collection: 'users',
      data: {
        email: 'test@payloadcms.com',
        password: 'test',
      },
    })

    post = await payload.create({
      collection: postsSlug,
      data: {
        text: 'some post',
      },
    })

    await payload.create({
      collection: pagesSlug,
      data: {
        text: 'some page',
      },
    })

    await payload.updateGlobal({
      slug: menuSlug,
      data: {
        globalText: 'global text',
      },
    })
  })

  afterAll(async () => {
    await payload.destroy()
  })

  afterEach(() => {
    postConfig.lockDocuments = { duration: 300 }
  })

  it('should update unlocked document - collection', async () => {
    const updatedPost = await payload.update({
      collection: postsSlug,
      data: {
        text: 'updated post',
      },
      id: post.id,
    })

    expect(updatedPost.text).toEqual('updated post')
  })

  it('should update unlocked document - global', async () => {
    const updatedGlobalMenu = await payload.updateGlobal({
      slug: menuSlug,
      data: {
        globalText: 'updated global text',
      },
    })

    expect(updatedGlobalMenu.globalText).toEqual('updated global text')
  })

  it('should delete unlocked document - collection', async () => {
    const { docs } = await payload.find({
      collection: postsSlug,
      depth: 0,
    })

    expect(docs).toHaveLength(2)

    await payload.delete({
      collection: postsSlug,
      id: post.id,
    })

    const { docs: deletedResults } = await payload.find({
      collection: postsSlug,
      depth: 0,
    })

    expect(deletedResults).toHaveLength(1)
  })

  it('should allow update of stale locked document - collection', async () => {
    const newPost2 = await payload.create({
      collection: postsSlug,
      data: {
        text: 'new post 2',
      },
    })

    // Set lock duration to 1 second for testing purposes
    postConfig.lockDocuments = { duration: 1 }

    // Give locking ownership to another user
    const lockedDocInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: {
          relationTo: 'posts',
          value: newPost2.id,
        },
        globalSlug: undefined,
      },
    })

    await wait(1100)

    const updateLockedDoc = await payload.update({
      collection: postsSlug,
      data: {
        text: 'updated post 2',
      },
      overrideLock: false,
      id: newPost2.id,
    })
    postConfig.lockDocuments = { duration: 300 }

    // Should allow update since editedAt date is past expiration duration.
    // Therefore the document is considered stale
    expect(updateLockedDoc.text).toEqual('updated post 2')

    // Check to make sure the document does not exist in payload-locked-documents anymore
    try {
      await payload.findByID({
        collection: lockedDocumentCollection,
        id: lockedDocInstance.id,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NotFound)
    }

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        id: { equals: lockedDocInstance.id },
      },
    })

    // Updating a document with the local API should not keep a stored doc
    // in the payload-locked-documents collection
    expect(docsFromLocksCollection.docs).toHaveLength(0)
  })

  it('should allow update of stale locked document - global', async () => {
    // Set lock duration to 1 second for testing purposes
    const globalConfig = payload.config.globals.find(
      ({ slug }) => slug === menuSlug,
    ) as SanitizedGlobalConfig
    globalConfig.lockDocuments = { duration: 1 }
    // Give locking ownership to another user
    const lockedGlobalInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: undefined,
        globalSlug: menuSlug,
      },
    })

    await wait(1100)

    const updateGlobalLockedDoc = await payload.updateGlobal({
      data: {
        globalText: 'global text 2',
      },
      overrideLock: false,
      slug: menuSlug,
    })
    globalConfig.lockDocuments = { duration: 300 }

    // Should allow update since editedAt date is past expiration duration.
    // Therefore the document is considered stale
    expect(updateGlobalLockedDoc.globalText).toEqual('global text 2')

    // Check to make sure the document does not exist in payload-locked-documents anymore
    try {
      await payload.findByID({
        collection: lockedDocumentCollection,
        id: lockedGlobalInstance.id,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NotFound)
    }

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        id: { equals: lockedGlobalInstance.id },
      },
    })

    // Updating a document with the local API should not keep a stored doc
    // in the payload-locked-documents collection
    expect(docsFromLocksCollection.docs).toHaveLength(0)
  })

  it('should not allow update of locked document - collection', async () => {
    const newPost = await payload.create({
      collection: postsSlug,
      data: {
        text: 'some post',
      },
    })

    // Give locking ownership to another user
    await payload.create({
      collection: lockedDocumentCollection,
      data: {
        document: {
          relationTo: 'posts',
          value: newPost.id,
        },
        globalSlug: undefined,
        user: {
          relationTo: 'users',
          value: user2.id,
        },
      },
    })

    try {
      await payload.update({
        collection: postsSlug,
        data: {
          text: 'updated post',
        },
        overrideLock: false, // necessary to trigger the lock check
        id: newPost.id,
      })
    } catch (error: any) {
      expect(error).toBeInstanceOf(Locked)
      expect(error.message).toMatch(/currently locked by another user and cannot be updated/)
    }

    const updatedPost = await payload.findByID({
      collection: postsSlug,
      id: newPost.id,
    })

    // Should not allow update - expect data not to change
    expect(updatedPost.text).toEqual('some post')
  })

  it('should not allow update of locked document - global', async () => {
    // Give locking ownership to another user
    await payload.create({
      collection: lockedDocumentCollection,
      data: {
        document: undefined,
        globalSlug: menuSlug,
        user: {
          relationTo: 'users',
          value: user2.id,
        },
      },
    })

    try {
      await payload.updateGlobal({
        data: {
          globalText: 'updated global text',
        },
        overrideLock: false, // necessary to trigger the lock check
        slug: menuSlug,
      })
    } catch (error: any) {
      expect(error).toBeInstanceOf(Locked)
      expect(error.message).toMatch(/currently locked by another user and cannot be updated/)
    }

    const updatedGlobalMenu = await payload.findGlobal({
      slug: menuSlug,
    })

    // Should not allow update - expect data not to change
    expect(updatedGlobalMenu.globalText).toEqual('global text 2')
  })

  // Try to delete locked document (collection)
  it('should not allow delete of locked document - collection', async () => {
    const newPost3 = await payload.create({
      collection: postsSlug,
      data: {
        text: 'new post 3',
      },
    })

    // Give locking ownership to another user
    await payload.create({
      collection: lockedDocumentCollection,
      data: {
        document: {
          relationTo: 'posts',
          value: newPost3.id,
        },
        globalSlug: undefined,
        user: {
          relationTo: 'users',
          value: user2.id,
        },
      },
    })

    try {
      await payload.delete({
        collection: postsSlug,
        id: newPost3.id,
        overrideLock: false, // necessary to trigger the lock check
      })
    } catch (error: any) {
      expect(error).toBeInstanceOf(Locked)
      expect(error.message).toMatch(/currently locked and cannot be deleted/)
    }

    const findPostDocs = await payload.find({
      collection: postsSlug,
      where: {
        id: { equals: newPost3.id },
      },
    })

    expect(findPostDocs.docs).toHaveLength(1)
  })

  it('should allow delete of stale locked document - collection', async () => {
    const newPost4 = await payload.create({
      collection: postsSlug,
      data: {
        text: 'new post 4',
      },
    })

    // Set lock duration to 1 second for testing purposes
    postConfig.lockDocuments = { duration: 1 }

    // Give locking ownership to another user
    const lockedDocInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: {
          relationTo: 'posts',
          value: newPost4.id,
        },
        globalSlug: undefined,
      },
    })

    await wait(1100)

    await payload.delete({
      collection: postsSlug,
      id: newPost4.id,
      overrideLock: false,
    })

    const findPostDocs = await payload.find({
      collection: postsSlug,
      where: {
        id: { equals: newPost4.id },
      },
    })

    expect(findPostDocs.docs).toHaveLength(0)

    // Check to make sure the document does not exist in payload-locked-documents anymore
    try {
      await payload.findByID({
        collection: lockedDocumentCollection,
        id: lockedDocInstance.id,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NotFound)
    }

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        id: { equals: lockedDocInstance.id },
      },
    })

    expect(docsFromLocksCollection.docs).toHaveLength(0)
  })

  it('should allow update of locked document w/ overrideLock flag - collection', async () => {
    const newPost5 = await payload.create({
      collection: postsSlug,
      data: {
        text: 'new post 5',
      },
    })

    // Give locking ownership to another user
    const lockedDocInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: {
          relationTo: 'posts',
          value: newPost5.id,
        },
        globalSlug: undefined,
      },
    })

    const updateLockedDoc = await payload.update({
      collection: postsSlug,
      data: {
        text: 'updated post 5',
      },
      id: newPost5.id,
      overrideLock: true,
    })

    // Should allow update since using overrideLock flag
    expect(updateLockedDoc.text).toEqual('updated post 5')

    // Check to make sure the document does not exist in payload-locked-documents anymore
    try {
      await payload.findByID({
        collection: lockedDocumentCollection,
        id: lockedDocInstance.id,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NotFound)
    }

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        id: { equals: lockedDocInstance.id },
      },
    })

    // Updating a document with the local API should not keep a stored doc
    // in the payload-locked-documents collection
    expect(docsFromLocksCollection.docs).toHaveLength(0)
  })

  it('should allow update of locked document w/ overrideLock flag - global', async () => {
    // Give locking ownership to another user
    const lockedGlobalInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        globalSlug: menuSlug,
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: undefined,
      },
    })

    const updateGlobalLockedDoc = await payload.updateGlobal({
      data: {
        globalText: 'updated global text 2',
      },
      slug: menuSlug,
      overrideLock: true,
    })

    // Should allow update since using overrideLock flag
    expect(updateGlobalLockedDoc.globalText).toEqual('updated global text 2')

    // Check to make sure the document does not exist in payload-locked-documents anymore
    try {
      await payload.findByID({
        collection: lockedDocumentCollection,
        id: lockedGlobalInstance.id,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NotFound)
    }

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        id: { equals: lockedGlobalInstance.id },
      },
    })

    // Updating a document with the local API should not keep a stored doc
    // in the payload-locked-documents collection
    expect(docsFromLocksCollection.docs).toHaveLength(0)
  })

  it('should allow delete of locked document w/ overrideLock flag - collection', async () => {
    const newPost6 = await payload.create({
      collection: postsSlug,
      data: {
        text: 'new post 6',
      },
    })

    // Give locking ownership to another user
    const lockedDocInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: {
          relationTo: 'posts',
          value: newPost6.id,
        },
        globalSlug: undefined,
      },
    })

    await payload.delete({
      collection: postsSlug,
      id: newPost6.id,
      overrideLock: true,
    })

    const findPostDocs = await payload.find({
      collection: postsSlug,
      where: {
        id: { equals: newPost6.id },
      },
    })

    expect(findPostDocs.docs).toHaveLength(0)

    // Check to make sure the document does not exist in payload-locked-documents anymore
    try {
      await payload.findByID({
        collection: lockedDocumentCollection,
        id: lockedDocInstance.id,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NotFound)
    }

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        id: { equals: lockedDocInstance.id },
      },
    })

    expect(docsFromLocksCollection.docs).toHaveLength(0)
  })

  it('should allow take over on locked doc (simulates take over modal from admin ui)', async () => {
    const newPost7 = await payload.create({
      collection: postsSlug,
      data: {
        text: 'new post 7',
      },
    })

    const lockedDocInstance = await payload.create({
      collection: lockedDocumentCollection,
      data: {
        user: {
          relationTo: 'users',
          value: user2.id,
        },
        document: {
          relationTo: 'posts',
          value: newPost7.id,
        },
        globalSlug: undefined,
      },
    })

    // This is the take over action - changing the user to the current user
    await payload.update({
      collection: 'payload-locked-documents',
      data: {
        user: { relationTo: 'users', value: user?.id },
      },
      id: lockedDocInstance.id,
    })

    const docsFromLocksCollection = await payload.find({
      collection: lockedDocumentCollection,
      where: {
        'user.value': { equals: user.id },
      },
    })

    expect(docsFromLocksCollection.docs).toHaveLength(1)
    expect((docsFromLocksCollection.docs[0]?.user.value as User)?.id).toEqual(user.id)
  })

  describe('Lock access', () => {
    let regular: User
    // The regular user owns this document, so may update it
    let ownedDoc: Restricted
    // Only admins may update this document
    let foreignDoc: Restricted

    const createLock = (data: { document?: Restricted; globalSlug?: string }) =>
      payload.create({
        collection: lockedDocumentCollection,
        data: {
          document: data.document
            ? { relationTo: restrictedSlug, value: data.document.id }
            : undefined,
          globalSlug: data.globalSlug,
          user: { relationTo: usersSlug, value: user.id },
        },
        depth: 0,
      })

    const findLock = (id: number | string) =>
      payload.findByID({ id, collection: lockedDocumentCollection, depth: 0 })

    const getLockedState = async (doc: Restricted, as: User, updateLastEdited?: boolean) => {
      const { lockedState } = await buildFormState({
        id: doc.id,
        collectionSlug: restrictedSlug,
        data: doc,
        docPermissions: undefined,
        docPreferences: { fields: {} },
        documentFormState: undefined,
        mockRSCs: true,
        operation: 'update',
        renderAllFields: false,
        req: await createLocalReq({ user: { ...as, collection: usersSlug } }, payload),
        returnLockStatus: true,
        schemaPath: restrictedSlug,
        updateLastEdited,
      })

      return lockedState
    }

    beforeAll(async () => {
      ;({
        docs: [regular],
      } = await payload.find({
        collection: usersSlug,
        where: { email: { equals: regularUser.email } },
      }))

      ownedDoc = await payload.create({
        collection: restrictedSlug,
        data: { owner: regular.id, text: 'owned' },
        depth: 0,
      })

      foreignDoc = await payload.create({
        collection: restrictedSlug,
        data: { text: 'foreign' },
        depth: 0,
      })

      await payload.updateGlobal({ slug: restrictedGlobalSlug, data: { text: 'restricted' } })
    })

    beforeEach(async () => {
      await payload.delete({
        collection: lockedDocumentCollection,
        where: { id: { exists: true } },
      })
    })

    it('should not create a lock over REST', async () => {
      await restClient.login({ slug: usersSlug, credentials: devUser })

      const response = await restClient.POST(`/${lockedDocumentCollection}`, {
        body: JSON.stringify({
          document: { relationTo: restrictedSlug, value: ownedDoc.id },
          user: { relationTo: usersSlug, value: user.id },
        }),
      })

      expect(response.status).toBe(403)

      const { totalDocs } = await payload.count({ collection: lockedDocumentCollection })

      expect(totalDocs).toBe(0)
    })

    it('should not create a lock over GraphQL', async () => {
      await restClient.login({ slug: usersSlug, credentials: devUser })

      const { errors } = await restClient
        .GRAPHQL_POST({
          body: JSON.stringify({
            query: `mutation {
              createPayloadLockedDocument(data: {
                globalSlug: "${menuSlug}",
                user: { relationTo: users, value: ${JSON.stringify(user.id)} }
              }) { id }
            }`,
          }),
        })
        .then((res) => res.json())

      expect(errors[0].extensions.statusCode).toBe(403)

      const { totalDocs } = await payload.count({ collection: lockedDocumentCollection })

      expect(totalDocs).toBe(0)
    })

    it('should hide a lock from a user who cannot update the locked document', async () => {
      const locks = [
        await createLock({ document: foreignDoc }),
        await createLock({ globalSlug: restrictedGlobalSlug }),
      ]

      await restClient.login({ slug: usersSlug, credentials: regularUser })

      const { docs } = await restClient
        .GET(`/${lockedDocumentCollection}`)
        .then((res) => res.json())

      expect(docs).toHaveLength(0)

      for (const lock of locks) {
        const response = await restClient.GET(`/${lockedDocumentCollection}/${lock.id}`)

        expect(response.status).toBe(404)
      }
    })

    it('should not let a user who cannot update the locked document change or delete its lock', async () => {
      const locks = [
        await createLock({ document: foreignDoc }),
        await createLock({ globalSlug: restrictedGlobalSlug }),
      ]
      const takeOver = {
        body: JSON.stringify({ user: { relationTo: usersSlug, value: regular.id } }),
      }

      await restClient.login({ slug: usersSlug, credentials: regularUser })

      for (const lock of locks) {
        const updated = await restClient.PATCH(`/${lockedDocumentCollection}/${lock.id}`, takeOver)

        expect(updated.status).toBe(403)

        const deleted = await restClient.DELETE(`/${lockedDocumentCollection}/${lock.id}`)

        expect(deleted.status).toBe(403)
      }

      const bulkUpdated = await restClient.PATCH(
        `/${lockedDocumentCollection}?where[id][exists]=true`,
        takeOver,
      )

      expect(bulkUpdated.status).toBe(403)

      const bulkDeleted = await restClient.DELETE(
        `/${lockedDocumentCollection}?where[id][exists]=true`,
      )

      expect(bulkDeleted.status).toBe(403)

      for (const lock of locks) {
        expect((await findLock(lock.id)).user.value).toBe(user.id)
      }
    })

    it('should let a user who can update the locked document take over its lock, as themself only', async () => {
      const lock = await createLock({ document: ownedDoc })

      await restClient.login({ slug: usersSlug, credentials: regularUser })

      // The admin UI finds the lock of the document, then names the current user on it
      const { docs } = await restClient
        .GET(
          `/${lockedDocumentCollection}?where[document.relationTo][equals]=${restrictedSlug}&where[document.value][equals]=${ownedDoc.id}`,
        )
        .then((res) => res.json())

      expect(docs).toHaveLength(1)

      const response = await restClient.PATCH(`/${lockedDocumentCollection}/${docs[0].id}`, {
        body: JSON.stringify({
          document: { relationTo: restrictedSlug, value: foreignDoc.id },
          user: { relationTo: usersSlug, value: user2.id },
        }),
      })

      expect(response.status).toBe(200)

      const takenOver = await findLock(lock.id)

      expect(takenOver.user.value).toBe(regular.id)
      expect(takenOver.document?.value).toBe(ownedDoc.id)
    })

    it('should let a user who can update the locked document delete its lock', async () => {
      const lock = await createLock({ document: ownedDoc })

      await restClient.login({ slug: usersSlug, credentials: regularUser })

      const response = await restClient.DELETE(`/${lockedDocumentCollection}/${lock.id}`)

      expect(response.status).toBe(200)

      const { totalDocs } = await payload.count({ collection: lockedDocumentCollection })

      expect(totalDocs).toBe(0)
    })

    it('should show the lock status of a document only to a user who can update it', async () => {
      await createLock({ document: ownedDoc })
      await createLock({ document: foreignDoc })

      const { docs } = await payload.find({
        collection: restrictedSlug,
        includeLockStatus: true,
        overrideAccess: false,
        user: { ...regular, collection: usersSlug },
      })

      expect(docs.find(({ id }) => id === ownedDoc.id)?._isLocked).toBe(true)
      expect(docs.find(({ id }) => id === foreignDoc.id)?._isLocked).toBe(false)
    })

    it('should lock a document for the user who edits it, and keep the lock while they edit', async () => {
      const lockedState = await getLockedState(ownedDoc, user)

      expect(lockedState?.isLocked).toBe(true)

      const {
        docs: [lock],
      } = await payload.find({ collection: lockedDocumentCollection, depth: 0 })

      expect(lock?.user.value).toBe(user.id)
      expect(lock?.document?.value).toBe(ownedDoc.id)

      // Another user who can update the document sees the lock, and gets none
      const incomingLockedState = await getLockedState(ownedDoc, regular)
      const editor = incomingLockedState?.user

      expect(typeof editor === 'object' ? editor.id : editor).toBe(user.id)

      await getLockedState(ownedDoc, user, true)

      const { docs: locks } = await payload.find({ collection: lockedDocumentCollection })

      expect(locks).toHaveLength(1)
      expect(new Date(locks[0]!.updatedAt).getTime()).toBeGreaterThan(
        new Date(lock!.updatedAt).getTime(),
      )
    })

    it('should not lock a document for a user who cannot update it', async () => {
      const lockedState = await getLockedState(foreignDoc, regular)

      expect(lockedState).toBeUndefined()

      const { totalDocs } = await payload.count({ collection: lockedDocumentCollection })

      expect(totalDocs).toBe(0)
    })
  })

  describe('Postgres lock transactions', { db: (adapter) => adapter === 'postgres' }, () => {
    const createdDocumentIDs: (number | string)[] = []
    const createdLockIDs: (number | string)[] = []

    afterEach(async () => {
      for (const id of createdLockIDs) {
        await payload.delete({ collection: lockedDocumentCollection, id, overrideAccess: true })
      }
      createdLockIDs.length = 0

      for (const id of createdDocumentIDs) {
        await payload.delete({ collection: simpleSlug, id, overrideAccess: true })
      }
      createdDocumentIDs.length = 0
    })
    for (const isolationLevel of ['repeatable read', 'serializable'] as const) {
      it(`should reject a save locked after a ${isolationLevel} snapshot`, async () => {
        const doc = await payload.create({
          collection: simpleSlug,
          data: { fieldA: 'before' },
          overrideAccess: true,
        })

        createdDocumentIDs.push(doc.id)
        const transactionID = await payload.db.beginTransaction({ isolationLevel })

        if (!transactionID) {
          throw new Error('Expected a Postgres transaction')
        }

        try {
          const req = { transactionID }

          await payload.findByID({
            collection: simpleSlug,
            id: doc.id,
            overrideAccess: true,
            req,
          })
          const lock = await payload.create({
            collection: lockedDocumentCollection,
            data: {
              document: { relationTo: simpleSlug, value: doc.id },
              user: { relationTo: usersSlug, value: user2.id },
            },
            overrideAccess: true,
          })

          createdLockIDs.push(lock.id)

          await expect(
            payload.update({
              collection: simpleSlug,
              id: doc.id,
              data: { fieldA: 'after' },
              overrideAccess: true,
              overrideLock: false,
              req,
              user,
            }),
          ).rejects.toBeInstanceOf(Locked)
        } finally {
          await payload.db.rollbackTransaction(transactionID)
        }
      })

      it(`should skip a bulk delete locked after a ${isolationLevel} snapshot`, async () => {
        const doc = await payload.create({
          collection: simpleSlug,
          data: {},
          overrideAccess: true,
        })

        createdDocumentIDs.push(doc.id)
        const transactionID = await payload.db.beginTransaction({ isolationLevel })

        if (!transactionID) {
          throw new Error('Expected a Postgres transaction')
        }

        try {
          const req = { transactionID }

          await payload.findByID({
            collection: simpleSlug,
            id: doc.id,
            overrideAccess: true,
            req,
          })
          const lock = await payload.create({
            collection: lockedDocumentCollection,
            data: {
              document: { relationTo: simpleSlug, value: doc.id },
              user: { relationTo: usersSlug, value: user2.id },
            },
            overrideAccess: true,
          })

          createdLockIDs.push(lock.id)

          const result = await payload.delete({
            collection: simpleSlug,
            where: { id: { equals: doc.id } },
            overrideAccess: true,
            overrideLock: false,
            req,
            user,
          })

          expect(result.docs).toEqual([])
          expect(result.errors).toEqual([
            expect.objectContaining({
              id: doc.id,
              message: expect.stringContaining('currently locked'),
            }),
          ])
        } finally {
          await payload.db.rollbackTransaction(transactionID)
        }

        const remaining = await payload.findByID({
          collection: simpleSlug,
          id: doc.id,
          overrideAccess: true,
        })

        expect(remaining.id).toBe(doc.id)
      })
    }

    it('should save a document using its existing transaction', async () => {
      const doc = await payload.create({
        collection: simpleSlug,
        overrideAccess: true,
        data: { fieldA: 'before' },
      })

      createdDocumentIDs.push(doc.id)

      const updated = await withFullPostgresPool({
        payload,
        operation: ({ req }) =>
          payload.update({
            collection: simpleSlug,
            overrideAccess: true,
            id: doc.id,
            data: { fieldA: 'after' },
            overrideLock: false,
            req,
          }),
      })

      expect(updated.fieldA).toBe('after')
    })

    it('should bulk delete documents using its existing transaction', async () => {
      const first = await payload.create({
        collection: simpleSlug,
        overrideAccess: true,
        data: {},
      })

      createdDocumentIDs.push(first.id)
      const second = await payload.create({
        collection: simpleSlug,
        overrideAccess: true,
        data: {},
      })

      createdDocumentIDs.push(second.id)

      const result = await withFullPostgresPool({
        payload,
        operation: ({ req }) =>
          payload.delete({
            collection: simpleSlug,
            overrideAccess: true,
            where: { id: { in: [first.id, second.id] } },
            overrideLock: false,
            req,
          }),
      })

      expect(result.errors).toEqual([])
      expect(result.docs.map(({ id }) => id).sort()).toEqual([first.id, second.id].sort())
    })
  })
})

async function withFullPostgresPool<T>({
  operation,
  payload,
}: {
  operation: (args: { req: Partial<PayloadRequest> }) => Promise<T>
  payload: Payload
}): Promise<T> {
  const { pool } = payload.db as unknown as PostgresAdapter
  const originalConnectionTimeout = pool.options.connectionTimeoutMillis
  const originalMax = pool.options.max
  const transactionIDs: (number | string)[] = []

  try {
    // Bound acquisition waits so a lock read outside the transaction fails instead of hanging.
    pool.options.connectionTimeoutMillis = 2000
    pool.options.max = 2

    while (pool.totalCount > pool.options.max && pool.idleCount > 0) {
      const client = await pool.connect()

      client.release(true)
    }

    // Some v3 adapters retain a startup connection. Reserve the remaining capacity so
    // the lock read cannot borrow another connection regardless of that lifecycle detail.
    while (pool.idleCount > 0 || pool.totalCount < pool.options.max) {
      const transactionID = await payload.db.beginTransaction()

      if (!transactionID) {
        throw new Error('Expected Postgres to start a transaction')
      }

      transactionIDs.push(transactionID)
    }

    if (!transactionIDs.length) {
      throw new Error('Expected an available transaction connection')
    }

    return await operation({ req: { transactionID: transactionIDs[0] } })
  } finally {
    try {
      await Promise.all(transactionIDs.map((id) => payload.db.rollbackTransaction(id)))
    } finally {
      pool.options.connectionTimeoutMillis = originalConnectionTimeout
      pool.options.max = originalMax
    }
  }
}
