import { deepMergeSimple } from '@payloadcms/translations/utilities'

import type { FlattenedField } from '../fields/config/types.js'
import type { SelectExcludeType, SelectIncludeType, SelectType } from '../types/index.js'

import { getSelectMode } from './getSelectMode.js'

// Transform post.title -> post, post.category.title -> post
const stripVirtualPathToCurrentCollection = ({
  fields,
  path,
  versions,
}: {
  fields: FlattenedField[]
  path: string
  versions: boolean
}) => {
  const resultSegments: string[] = []

  if (versions) {
    resultSegments.push('version')
    const versionField = fields.find((each) => each.name === 'version')

    if (versionField && versionField.type === 'group') {
      fields = versionField.flattenedFields
    }
  }

  for (const segment of path.split('.')) {
    const field = fields.find((each) => each.name === segment)

    if (!field) {
      continue
    }

    resultSegments.push(segment)

    if (field.type === 'relationship' || field.type === 'upload') {
      return resultSegments.join('.')
    }
  }

  return resultSegments.join('.')
}

const getAllVirtualRelations = ({ fields }: { fields: FlattenedField[] }) => {
  const result: string[] = []

  for (const field of fields) {
    if ('virtual' in field && typeof field.virtual === 'string') {
      result.push(field.virtual)
    } else if (field.type === 'group' || field.type === 'tab') {
      const nestedResult = getAllVirtualRelations({ fields: field.flattenedFields })

      for (const nestedItem of nestedResult) {
        result.push(nestedItem)
      }
    }
  }

  return result
}

const resolveVirtualRelationsToSelect = ({
  fields,
  selectValue,
  topLevelFields,
  versions,
}: {
  fields: FlattenedField[]
  selectValue: SelectIncludeType | true
  topLevelFields: FlattenedField[]
  versions: boolean
}) => {
  const result: string[] = []
  if (selectValue === true) {
    for (const item of getAllVirtualRelations({ fields })) {
      result.push(
        stripVirtualPathToCurrentCollection({ fields: topLevelFields, path: item, versions }),
      )
    }
  } else {
    for (const fieldName in selectValue) {
      const field = fields.find((each) => each.name === fieldName)
      if (!field) {
        continue
      }

      if ('virtual' in field && typeof field.virtual === 'string') {
        result.push(
          stripVirtualPathToCurrentCollection({
            fields: topLevelFields,
            path: field.virtual,
            versions,
          }),
        )
      } else if (field.type === 'group' || field.type === 'tab') {
        for (const item of resolveVirtualRelationsToSelect({
          fields: field.flattenedFields,
          selectValue: selectValue[fieldName]!,
          topLevelFields,
          versions,
        })) {
          result.push(
            stripVirtualPathToCurrentCollection({ fields: topLevelFields, path: item, versions }),
          )
        }
      }
    }
  }

  return result
}

// An excluding select cannot exclude all of a field but its forced paths, so a field with any
// forced path is read whole.
const removeForcedExclusions = ({
  forceSelect,
  select,
}: {
  forceSelect: SelectType
  select: SelectExcludeType
}): SelectExcludeType => {
  const result: SelectExcludeType = {}

  for (const key in select) {
    const forced = forceSelect[key]
    const excluded = select[key]!

    if (!forced) {
      result[key] = excluded
    } else if (typeof forced === 'object' && typeof excluded === 'object') {
      const nested = removeForcedExclusions({ forceSelect: forced, select: excluded })

      if (Object.keys(nested).length) {
        result[key] = nested
      }
    }
  }

  return result
}

export const sanitizeSelect = ({
  fields,
  forceSelect,
  select,
  versions,
}: {
  fields: FlattenedField[]
  forceSelect?: SelectType
  select?: SelectType
  versions?: boolean
}): SelectType | undefined => {
  if (!select) {
    return select
  }

  const selectMode = getSelectMode(select)

  if (selectMode === 'exclude') {
    if (!forceSelect) {
      return select
    }

    const exclusions = removeForcedExclusions({ forceSelect, select: select as SelectExcludeType })

    // getSelectMode reads a select by its first `false` or object, so what is left of a select
    // that also holds `true` can read as one that includes fields, which leaves out the forced ones.
    // Nothing left to exclude reads the same.
    return getSelectMode(exclusions) === 'exclude' ? exclusions : undefined
  }

  if (forceSelect) {
    select = deepMergeSimple(select, forceSelect)
  }

  if (select) {
    const virtualRelations = resolveVirtualRelationsToSelect({
      fields,
      selectValue: select as SelectIncludeType,
      topLevelFields: fields,
      versions: versions ?? false,
    })

    for (const path of virtualRelations) {
      let currentRef = select
      const segments = path.split('.')
      for (let i = 0; i < segments.length; i++) {
        const isLast = segments.length - 1 === i
        const segment = segments[i]!

        if (isLast) {
          currentRef[segment] = true
        } else {
          if (!(segment in currentRef)) {
            currentRef[segment] = {}
            currentRef = currentRef[segment]
          }
        }
      }
    }
  }

  return select
}
