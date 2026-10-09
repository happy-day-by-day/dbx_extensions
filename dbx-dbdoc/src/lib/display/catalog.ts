import type { DbTable } from '../dialects/entities'
import { compileFilterPattern, tableMatchesFilter, CATALOG_FILTER_DIMENSIONS } from './filters'
import { tableSearchKey } from './columnSearch'

export interface CatalogOptions {
  keyword: string
  regexMode: boolean
  schema: string | null
  columnHits: Set<string>
  uncommented: boolean
  sort: 'name' | 'columns'
}

export function selectCatalogTables(tables: DbTable[], options: CatalogOptions): DbTable[] {
  const pattern = compileFilterPattern(options.keyword.trim(), options.regexMode)
  if (pattern.error) return []
  return tables.filter((table) => {
    if (options.schema && table.table_schema !== options.schema) return false
    if (options.uncommented && table.table_comment.trim()) return false
    return !pattern.regex || tableMatchesFilter(table, options.keyword, CATALOG_FILTER_DIMENSIONS, { pattern: pattern.regex })
      || (!options.regexMode && options.columnHits.has(tableSearchKey(table.table_schema, table.table_name)))
  }).sort((a, b) => {
    if (options.sort === 'columns' && a.column_count !== b.column_count) return b.column_count - a.column_count
    return a.table_name.localeCompare(b.table_name) || a.table_schema.localeCompare(b.table_schema)
  })
}

export function virtualRange(count: number, scrollTop: number, height: number, rowHeight = 72) {
  const visibleCount = Math.max(1, Math.ceil(height / rowHeight))
  const top = Math.min(Math.max(0, Math.floor(scrollTop / rowHeight)), Math.max(0, count - visibleCount))
  const start = Math.max(0, top - 4)
  const end = Math.min(count, top + visibleCount + 4)
  return { start, end, before: start * rowHeight, after: Math.max(0, count - end) * rowHeight }
}
