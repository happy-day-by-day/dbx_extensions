// 目录过滤纯函数：由 data-watcher databaseFilters.mjs 移植并裁剪——
// 目录表无列数据，搜索索引仅保留 tableName/tableComment/schema 三维
// （columnName/columnComment 维度、joinSearchValues/withTableSearchIndex/mergeFilterDimensions 已删除）；
// 入参从 { table, columns } 包装结构改为扁平 DbTable，schema 维仍含 schema 与 schema.table 拼接串。
import type { DbTable } from '../dialects/entities'

export interface FilterDimensions {
  tableName: boolean
  tableComment: boolean
  schema: boolean
}

export interface CatalogSearchIndex {
  tableName: string
  tableComment: string
  schema: string
}

export interface FilterPatternState {
  regex: RegExp | null
  error: string
}

interface TableFilterOptions {
  pattern?: RegExp | null
  regexMode?: boolean
}

export const CATALOG_FILTER_DIMENSIONS: FilterDimensions = {
  tableName: true,
  tableComment: true,
  schema: true
}

const normalizeSearchText = (value: unknown): string => String(value || '').toLowerCase()

export const buildTableSearchIndex = (table: DbTable): CatalogSearchIndex => {
  const schema = normalizeSearchText(table.table_schema)
  const qualifiedName = schema ? `${schema}.${normalizeSearchText(table.table_name)}` : ''

  return {
    tableName: normalizeSearchText(table.table_name),
    tableComment: normalizeSearchText(table.table_comment),
    schema: [schema, qualifiedName].filter(Boolean).join('\n')
  }
}

const createFilterRegex = (keyword: string): RegExp => {
  if (!keyword) {
    return new RegExp('.*')
  }
  const escapedKeyword = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escapedKeyword, 'i')
}

export const compileFilterPattern = (keyword: string, regexMode = false): FilterPatternState => {
  if (!keyword) {
    return { regex: null, error: '' }
  }
  if (!regexMode) {
    return { regex: createFilterRegex(keyword), error: '' }
  }
  try {
    return { regex: new RegExp(String(keyword), 'im'), error: '' }
  } catch (error) {
    return { regex: null, error: `正则表达式无效：${error instanceof Error ? error.message : String(error)}` }
  }
}

const matchesSearchText = (value: string, regex: RegExp): boolean => {
  regex.lastIndex = 0
  return regex.test(value)
}

export const tableMatchesFilter = (
  table: DbTable,
  keyword: string,
  dimensions: FilterDimensions,
  options: TableFilterOptions = {}
): boolean => {
  const searchIndex = buildTableSearchIndex(table)
  const patternState = options.pattern
    ? { regex: options.pattern, error: '' }
    : compileFilterPattern(keyword, options.regexMode)
  const regex = patternState.regex

  if (!regex || patternState.error) {
    return false
  }

  if (dimensions.tableName && matchesSearchText(searchIndex.tableName, regex)) {
    return true
  }
  if (dimensions.tableComment && matchesSearchText(searchIndex.tableComment, regex)) {
    return true
  }
  if (dimensions.schema && matchesSearchText(searchIndex.schema, regex)) {
    return true
  }

  return false
}

export const filterDatabaseTables = (tables: DbTable[], keyword: string, regexMode = false): DbTable[] => {
  const sourceTables = Array.isArray(tables) ? tables : []
  if (!keyword) {
    return sourceTables
  }
  const patternState = compileFilterPattern(keyword, regexMode)
  if (!patternState.regex || patternState.error) {
    return sourceTables
  }
  return sourceTables.filter((table) => {
    return tableMatchesFilter(table, keyword, CATALOG_FILTER_DIMENSIONS, { pattern: patternState.regex })
  })
}
