import type { MarkRequired } from 'ts-essentials'

import { v4 as uuid } from 'uuid'

import type { SanitizedCollectionConfig, TypeWithID } from '../collections/config/types.js'
import type { TypedUser } from '../index.js'
import type { Payload, PayloadRequest } from '../types/index.js'
import type { UntypedUser, UserSession } from './types.js'

import { commitTransaction } from '../utilities/commitTransaction.js'
import { initTransaction } from '../utilities/initTransaction.js'
import { killTransaction } from '../utilities/killTransaction.js'

/**
 * Removes expired sessions from an array of sessions
 */
export const removeExpiredSessions = (sessions: UserSession[]) => {
  const now = new Date()

  return sessions.filter(({ expiresAt }) => {
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
    return expiry > now
  })
}

/**
 * Writes the sessions that `update` makes of the user's stored ones, and returns them. The user is
 * read locked in a transaction, so that writers of a user take turns and none writes back sessions,
 * a hash or anything else that another changed after it read the user.
 */
export const updateSessions = async ({
  collectionConfig,
  payload,
  req,
  update,
  userID,
}: {
  collectionConfig: SanitizedCollectionConfig
  payload: Payload
  req: MarkRequired<Partial<PayloadRequest>, 'payload'>
  update: (sessions: UserSession[]) => UserSession[]
  userID: TypeWithID['id']
}): Promise<undefined | UserSession[]> => {
  const shouldCommit = await initTransaction(req)

  try {
    const user = await payload.db.findOne<
      { sessions?: UserSession[]; updatedAt?: null | string } & TypeWithID
    >({
      collection: collectionConfig.slug,
      lock: true,
      req,
      where: { id: { equals: userID } },
    })

    if (user) {
      user.sessions = update(user.sessions ?? [])

      // Prevent updatedAt from being updated when only changing sessions
      user.updatedAt = null

      // The whole user, as logout writes it: a write that holds an array clears the arrays it leaves
      // out in the SQL adapters
      await payload.db.updateOne({
        id: userID,
        collection: collectionConfig.slug,
        data: user,
        req,
        returning: false,
      })
    }

    if (shouldCommit) {
      await commitTransaction(req)
    }

    return user?.sessions
  } catch (error: unknown) {
    await killTransaction(req)
    throw error
  }
}

/**
 * Adds a session to the user and removes expired sessions
 * @returns The session ID (sid) if sessions are used
 */
export const addSessionToUser = async ({
  collectionConfig,
  payload,
  req,
  user,
}: {
  collectionConfig: SanitizedCollectionConfig
  payload: Payload
  req: PayloadRequest
  user: TypedUser
}): Promise<{ sid?: string }> => {
  let sid: string | undefined
  if (collectionConfig.auth.useSessions) {
    // Add session to user
    sid = uuid()
    const now = new Date()
    const tokenExpInMs = collectionConfig.auth.tokenExpiration * 1000
    const expiresAt = new Date(now.getTime() + tokenExpInMs)

    const session = { id: sid, createdAt: now, expiresAt }

    user.sessions = await updateSessions({
      collectionConfig,
      payload,
      req,
      update: (sessions) => [...removeExpiredSessions(sessions), session],
      userID: user.id,
    })

    user.collection = collectionConfig.slug
    user._strategy = 'local-jwt'
  }

  return {
    sid,
  }
}

export const revokeSession = async ({
  collectionConfig,
  payload,
  req,
  sid,
  user,
}: {
  collectionConfig: SanitizedCollectionConfig
  payload: Payload
  req: PayloadRequest
  sid: string
  user: null | (TypeWithID & UntypedUser)
}): Promise<void> => {
  if (collectionConfig.auth.useSessions && user) {
    user.sessions = await updateSessions({
      collectionConfig,
      payload,
      req,
      update: (sessions) => sessions.filter((session) => session.id !== sid),
      userID: user.id,
    })
  }
}

/**
 * Removes all sessions except the one with the ID `sid`, which goes too once it has expired
 */
export const removeOtherSessions = (sessions: UserSession[], sid?: string) =>
  removeExpiredSessions(sessions).filter(({ id }) => id === sid)

/**
 * Revokes all of a user's sessions, except the one with the ID `exceptSid` when given
 */
export const revokeSessions = async ({
  collectionConfig,
  exceptSid,
  payload,
  req,
  userID,
}: {
  collectionConfig: SanitizedCollectionConfig
  exceptSid?: string
  payload: Payload
  req: PayloadRequest
  userID: TypeWithID['id']
}): Promise<void> => {
  if (collectionConfig.auth.useSessions) {
    await updateSessions({
      collectionConfig,
      payload,
      req,
      update: (sessions) => removeOtherSessions(sessions, exceptSid),
      userID,
    })
  }
}
