'use client'

import React from 'react'

import { useWatchForm } from '../../Form/context.js'

type RowLabelType<T = unknown> = {
  readonly data: T
  readonly path: string
  readonly rowNumber?: number
}

const RowLabel = React.createContext<RowLabelType>({
  data: {},
  path: '',
  rowNumber: undefined,
})

type Props<T> = {
  readonly children: React.ReactNode
} & Omit<RowLabelType<T>, 'data'>

export const RowLabelProvider: React.FC<Props<unknown>> = ({ children, path, rowNumber }) => {
  // The context value stays a new object on every render, as it was while `data` was built on
  // every render, so that a row label reading `data` keeps following the form.
  'use no memo'
  const { getDataByPath, getSiblingData } = useWatchForm()

  // The row's data is built when a row label reads it: both getters walk every field of the form,
  // and every row called them on every render.
  let data: unknown
  let isRead = false
  const contextValue = {
    get data() {
      if (!isRead) {
        data = getDataByPath(path) || getSiblingData(path)
        isRead = true
      }
      return data
    },
    path,
    rowNumber,
  }

  return <RowLabel value={contextValue}>{children}</RowLabel>
}

export const useRowLabel = <T,>() => {
  return React.use(RowLabel) as RowLabelType<T>
}
