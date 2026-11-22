import type { FindOneArgs, SanitizedCollectionConfig, TypeWithID } from 'payload'

import { eq } from 'drizzle-orm'
import toSnakeCase from 'to-snake-case'

import type { DrizzleAdapter, PostgresDB } from './types.js'

import { findMany } from './find/findMany.js'
import { getTransaction } from './utilities/getTransaction.js'

export async function findOne<T extends TypeWithID>(
  this: DrizzleAdapter,
  { collection, draftsEnabled, joins, locale, lock, req, select, where }: FindOneArgs,
): Promise<null | T> {
  const collectionConfig: SanitizedCollectionConfig = this.payload.collections[collection].config

  const tableName = this.tableNameMap.get(toSnakeCase(collectionConfig.slug))

  const find = async () =>
    (
      await findMany({
        adapter: this,
        collectionSlug: collection,
        draftsEnabled,
        fields: collectionConfig.flattenedFields,
        joins,
        limit: 1,
        locale,
        page: 1,
        pagination: false,
        req,
        select,
        sort: undefined,
        tableName,
        where,
      })
    ).docs?.[0] as T | undefined

  const doc = await find()

  if (!doc || !lock || this.name !== 'postgres') {
    return doc || null
  }

  // The read above finds the row, and the read after the lock gives what the last writer left.
  const table = this.tables[tableName]!
  // as an update that leaves the ID alone, so that rows referencing it can still be added
  await ((await getTransaction(this, req)) as PostgresDB)
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, doc.id))
    .for('no key update')

  return (await find()) || null
}
