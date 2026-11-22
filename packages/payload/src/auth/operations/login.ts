import type {
  AuthOperationsFromCollectionSlug,
  Collection,
  DataFromCollectionSlug,
} from '../../collections/config/types.js'
import type { AuthCollectionSlug, TypedUser } from '../../index.js'
import type { PayloadRequest, Where } from '../../types/index.js'

import { buildAfterOperation } from '../../collections/operations/utilities/buildAfterOperation.js'
import { buildBeforeOperation } from '../../collections/operations/utilities/buildBeforeOperation.js'
import {
  AuthenticationError,
  LockedAuth,
  UnverifiedEmail,
  ValidationError,
} from '../../errors/index.js'
import { commitTransaction, Forbidden, initTransaction } from '../../index.js'
import { appendNonTrashedFilter } from '../../utilities/appendNonTrashedFilter.js'
import { killTransaction } from '../../utilities/killTransaction.js'
import { sanitizeInternalFields } from '../../utilities/sanitizeInternalFields.js'
import { applyUserReadAccess } from '../applyUserReadAccess.js'
import { getFieldsToSign } from '../getFieldsToSign.js'
import { getLoginOptions } from '../getLoginOptions.js'
import { isUserLocked } from '../isUserLocked.js'
import { jwtSign } from '../jwt.js'
import { addSessionToUser, revokeSession } from '../sessions.js'
import { authenticateLocalStrategy } from '../strategies/local/authenticate.js'
import { generatePasswordSaltHash } from '../strategies/local/generatePasswordSaltHash.js'
import { incrementLoginAttempts } from '../strategies/local/incrementLoginAttempts.js'
import { resetLoginAttempts } from '../strategies/local/resetLoginAttempts.js'

export type LoginResult<TSlug extends AuthCollectionSlug> = {
  exp?: number
  token?: string
  user?: DataFromCollectionSlug<TSlug>
}

export type Arguments<TSlug extends AuthCollectionSlug> = {
  collection: Collection
  data: AuthOperationsFromCollectionSlug<TSlug>['login']
  depth?: number
  overrideAccess?: boolean
  req: PayloadRequest
  showHiddenFields?: boolean
}

type CheckLoginPermissionArgs<TSlug extends AuthCollectionSlug> = {
  loggingInWithUsername?: boolean
  req: PayloadRequest
  user: DataFromCollectionSlug<TSlug>
}

/**
 * Throws an error if the user is locked or does not exist.
 * This does not check the login attempts, only the lock status. Whoever increments login attempts
 * is responsible for locking the user properly, not whoever checks the login permission.
 */
export const checkLoginPermission = <TSlug extends AuthCollectionSlug>({
  loggingInWithUsername,
  req,
  user,
}: CheckLoginPermissionArgs<TSlug>) => {
  if (!user) {
    throw new AuthenticationError(req.t, Boolean(loggingInWithUsername))
  }

  if (isUserLocked(new Date(user.lockUntil))) {
    throw new LockedAuth(req.t)
  }
}

type AuthenticateWithPasswordArgs<TSlug extends AuthCollectionSlug> = {
  collection: Collection
  data: AuthOperationsFromCollectionSlug<TSlug>['login']
  req: PayloadRequest
}

/**
 * Finds the user that the email or username names and checks their password, as login does.
 * A wrong password counts towards `maxLoginAttempts`. No session starts: `loginUser` starts one.
 */
export const authenticateWithPassword = async <TSlug extends AuthCollectionSlug>({
  collection: { config: collectionConfig },
  data,
  req,
  req: { payload },
}: AuthenticateWithPasswordArgs<TSlug>): Promise<TypedUser> => {
  const { email: unsanitizedEmail, password } = data
  const loginWithUsername = collectionConfig.auth.loginWithUsername

  const sanitizedEmail =
    typeof unsanitizedEmail === 'string' ? unsanitizedEmail.toLowerCase().trim() : null
  const sanitizedUsername =
    'username' in data && typeof data?.username === 'string'
      ? data.username.toLowerCase().trim()
      : null

  const { canLoginWithEmail, canLoginWithUsername } = getLoginOptions(loginWithUsername)

  // cannot login with email, did not provide username
  if (!canLoginWithEmail && !sanitizedUsername) {
    throw new ValidationError({
      collection: collectionConfig.slug,
      errors: [{ message: req.i18n.t('validation:required'), path: 'username' }],
    })
  }

  // cannot login with username, did not provide email
  if (!canLoginWithUsername && !sanitizedEmail) {
    throw new ValidationError({
      collection: collectionConfig.slug,
      errors: [{ message: req.i18n.t('validation:required'), path: 'email' }],
    })
  }

  // can login with either email or username, did not provide either
  if (!sanitizedUsername && !sanitizedEmail) {
    throw new ValidationError({
      collection: collectionConfig.slug,
      errors: [
        { message: req.i18n.t('validation:required'), path: 'email' },
        { message: req.i18n.t('validation:required'), path: 'username' },
      ],
    })
  }

  // did not provide password for login
  if (typeof password !== 'string' || password.trim() === '') {
    throw new ValidationError({
      collection: collectionConfig.slug,
      errors: [{ message: req.i18n.t('validation:required'), path: 'password' }],
    })
  }

  let whereConstraint: Where = {}
  const emailConstraint: Where = {
    email: {
      equals: sanitizedEmail,
    },
  }
  const usernameConstraint: Where = {
    username: {
      equals: sanitizedUsername,
    },
  }

  if (canLoginWithEmail && canLoginWithUsername && (sanitizedUsername || sanitizedEmail)) {
    if (sanitizedUsername) {
      whereConstraint = {
        or: [
          usernameConstraint,
          {
            email: {
              equals: sanitizedUsername,
            },
          },
        ],
      }
    } else {
      whereConstraint = {
        or: [
          emailConstraint,
          {
            username: {
              equals: sanitizedEmail,
            },
          },
        ],
      }
    }
  } else if (canLoginWithEmail && sanitizedEmail) {
    whereConstraint = emailConstraint
  } else if (canLoginWithUsername && sanitizedUsername) {
    whereConstraint = usernameConstraint
  }

  // Exclude trashed users
  whereConstraint = appendNonTrashedFilter({
    enableTrash: collectionConfig.trash,
    trash: false,
    where: whereConstraint,
  })

  let user = (await payload.db.findOne<TypedUser>({
    collection: collectionConfig.slug,
    req,
    where: whereConstraint,
  })) as TypedUser

  checkLoginPermission({
    loggingInWithUsername: Boolean(canLoginWithUsername && sanitizedUsername),
    req,
    user,
  })

  const authenticatedHash = user.hash
  const authenticatedSalt = user.salt
  const authResult = await authenticateLocalStrategy({
    doc: user,
    password,
    passwordHashIterations: payload.config.auth.passwordHashIterations,
  })
  user = sanitizeInternalFields(user)

  if (!authResult) {
    if (collectionConfig.auth.maxLoginAttempts > 0) {
      await incrementLoginAttempts({
        collection: collectionConfig,
        payload: req.payload,
        user,
      })

      // Re-check login permissions and max attempts after incrementing attempts, in case parallel updates occurred
      checkLoginPermission({
        loggingInWithUsername: Boolean(canLoginWithUsername && sanitizedUsername),
        req,
        user,
      })
    }

    throw new AuthenticationError(req.t)
  }

  if (
    authResult.shouldUpdatePasswordHash &&
    typeof authenticatedHash === 'string' &&
    typeof authenticatedSalt === 'string'
  ) {
    try {
      const { hash, salt } = await generatePasswordSaltHash({
        collection: collectionConfig,
        isPasswordAuthenticated: true,
        password,
        req,
      })

      await payload.db.updateOne({
        collection: collectionConfig.slug,
        data: { hash, salt },
        req,
        select: { id: true },
        where: {
          id: { equals: user.id },
          hash: { equals: authenticatedHash },
          salt: { equals: authenticatedSalt },
        },
      })
    } catch (err) {
      // Rehashing is opportunistic and is retried on the next login, so a failure here
      // must not reject an otherwise valid login
      payload.logger.error({ err, msg: 'Failed to update the stored password hash' })
    }
  }

  return user
}

type LoginUserArgs = {
  collection: Collection
  /**
   * Leaves the user's login attempts as they are, for a sign-in that doesn't prove the password,
   * so that it doesn't undo the lock that wrong passwords count towards.
   */
  keepLoginAttempts?: boolean
  req: PayloadRequest
  user: TypedUser
}

export type LoginUserResult = {
  exp: number
  /** The ID of the session the token belongs to, when the collection uses sessions */
  sid?: string
  token: string
  user: TypedUser
}

/**
 * Logs in a user who is already authenticated, by `authenticateWithPassword` or any other way, as
 * login does: adds a session, resets the login attempts unless `keepLoginAttempts`, signs a token
 * and runs the `beforeLogin` and `afterLogin` hooks. Throws if the user is locked or has not
 * verified their email.
 */
export const loginUser = async ({
  collection: { config: collectionConfig },
  keepLoginAttempts = false,
  req,
  req: {
    payload,
    payload: { secret },
  },
  user: authenticatedUser,
}: LoginUserArgs): Promise<LoginUserResult> => {
  let user = authenticatedUser

  if (collectionConfig.auth.verify && user._verified === false) {
    throw new UnverifiedEmail({ t: req.t })
  }

  user.collection = collectionConfig.slug
  user._strategy = 'local-jwt'

  const shouldCommit = await initTransaction(req)
  let sid: string | undefined

  try {
    const maxLoginAttemptsEnabled = collectionConfig.auth.maxLoginAttempts > 0

    /*
     * Correct password accepted - re‑check that the account didn't
     * get locked by parallel bad attempts in the meantime.
     */
    if (maxLoginAttemptsEnabled) {
      const { lockUntil, loginAttempts } = (await payload.db.findOne<TypedUser>({
        collection: collectionConfig.slug,
        req,
        select: {
          lockUntil: true,
          loginAttempts: true,
        },
        where: { id: { equals: user.id } },
      }))!

      user.lockUntil = lockUntil
      user.loginAttempts = loginAttempts

      checkLoginPermission({
        req,
        user,
      })
    }

    const fieldsToSignArgs: Parameters<typeof getFieldsToSign>[0] = {
      collectionConfig,
      email: user.email!,
      user,
    }

    const session = await addSessionToUser({
      collectionConfig,
      payload,
      req,
      user,
    })
    sid = session.sid

    if (sid) {
      fieldsToSignArgs.sid = sid
    }

    const fieldsToSign = getFieldsToSign(fieldsToSignArgs)

    if (maxLoginAttemptsEnabled && !keepLoginAttempts) {
      await resetLoginAttempts({
        collection: collectionConfig,
        doc: user,
        payload: req.payload,
        req,
      })
    }

    // /////////////////////////////////////
    // beforeLogin - Collection
    // /////////////////////////////////////

    if (collectionConfig.hooks?.beforeLogin?.length) {
      for (const hook of collectionConfig.hooks.beforeLogin) {
        user =
          (await hook({
            collection: collectionConfig,
            context: req.context,
            req,
            user,
          })) || user
      }
    }

    const { exp, token } = await jwtSign({
      fieldsToSign,
      secret,
      tokenExpiration: collectionConfig.auth.tokenExpiration,
    })

    req.user = user

    // /////////////////////////////////////
    // afterLogin - Collection
    // /////////////////////////////////////

    if (collectionConfig.hooks?.afterLogin?.length) {
      for (const hook of collectionConfig.hooks.afterLogin) {
        user =
          (await hook({
            collection: collectionConfig,
            context: req.context,
            req,
            token,
            user,
          })) || user
      }
    }

    if (shouldCommit) {
      await commitTransaction(req)
    }

    return { exp, sid, token, user }
  } catch (error: unknown) {
    if (sid) {
      await revokeSession({
        collectionConfig,
        payload,
        req,
        sid,
        user,
      })
    }
    await killTransaction(req)
    throw error
  }
}

export const loginOperation = async <TSlug extends AuthCollectionSlug>(
  incomingArgs: Arguments<TSlug>,
): Promise<LoginResult<TSlug>> => {
  let args = incomingArgs

  if (args.collection.config.auth.disableLocalStrategy) {
    throw new Forbidden(args.req.t)
  }

  // /////////////////////////////////////
  // beforeOperation - Collection
  // /////////////////////////////////////

  args = await buildBeforeOperation({
    args,
    collection: args.collection.config,
    operation: 'login',
    overrideAccess: args.overrideAccess!,
  })

  const {
    collection,
    collection: { config: collectionConfig },
    data,
    depth,
    overrideAccess = false,
    req,
    req: { payload },
    showHiddenFields,
  } = args

  // /////////////////////////////////////
  // Login
  // /////////////////////////////////////

  const authenticatedUser = await authenticateWithPassword({ collection, data, req })

  // Authentication successful - start transaction for remaining operations
  const shouldCommit = await initTransaction(args.req)
  let login: LoginUserResult | undefined

  try {
    login = await loginUser({ collection, req, user: authenticatedUser })

    // /////////////////////////////////////
    // afterRead - Fields
    // /////////////////////////////////////

    const userWithReadAccess = await applyUserReadAccess({
      collection: collectionConfig,
      depth: depth!,
      overrideAccess,
      req,
      showHiddenFields: showHiddenFields!,
      user: login.user,
    })

    let result: LoginResult<TSlug> = {
      exp: login.exp,
      token: login.token,
      user: userWithReadAccess,
    }

    // /////////////////////////////////////
    // afterOperation - Collection
    // /////////////////////////////////////

    result = await buildAfterOperation({
      args,
      collection: args.collection?.config,
      operation: 'login',
      overrideAccess: args.overrideAccess!,
      result,
    })

    if (shouldCommit) {
      await commitTransaction(req)
    }

    // /////////////////////////////////////
    // Return results
    // /////////////////////////////////////

    return result
  } catch (error: unknown) {
    // loginUser revokes its session when it throws itself
    if (login?.sid) {
      await revokeSession({
        collectionConfig,
        payload,
        req,
        sid: login.sid,
        user: login.user,
      })
    }
    await killTransaction(args.req)
    throw error
  }
}
