import type { DbTable } from './dialects/entities'
import type { TableDetail } from './markdown'
import { renderSchemaMarkdown } from './markdown'
import type { ExportSchemaResult } from './store'

const keyOf = (schema: string, table: string) => JSON.stringify([schema, table])
const detailKey = (detail: TableDetail) => keyOf(detail.table.table_schema, detail.table.table_name)

export function remainingExportTables(tables: DbTable[], details: TableDetail[]): DbTable[] {
  const completed = new Set(details.map(detailKey))
  return tables.filter((table) => !completed.has(keyOf(table.table_schema, table.table_name)))
}

// 重试只合并实际返回的表；未开始的失败项保留，成功项按最初导出范围排序。
export function mergeExportResult(tables: DbTable[], previous: ExportSchemaResult, next: ExportSchemaResult): ExportSchemaResult {
  const allowed = new Set(tables.map((table) => keyOf(table.table_schema, table.table_name)))
  const details = new Map([...previous.details, ...next.details].filter((detail) => allowed.has(detailKey(detail))).map((detail) => [detailKey(detail), detail]))
  const failed = new Map([...previous.failed, ...next.failed].filter((failure) => allowed.has(keyOf(failure.schema, failure.table))).map((failure) => [keyOf(failure.schema, failure.table), failure]))
  for (const key of details.keys()) failed.delete(key)
  const keys = tables.map((table) => keyOf(table.table_schema, table.table_name))
  return {
    details: keys.map((key) => details.get(key)).filter((detail): detail is TableDetail => Boolean(detail)),
    failed: keys.map((key) => failed.get(key)).filter((failure): failure is ExportSchemaResult['failed'][number] => Boolean(failure))
  }
}

export function renderExportResult(title: string, result: ExportSchemaResult, dbType: string, total: number, truncated: boolean, stopped: boolean): string {
  if (!result.details.length) return ''
  const missing = Math.max(0, total - result.details.length - result.failed.length)
  const notes = [stopped ? '生成已停止。' : '', result.failed.length ? `${result.failed.length} 张表读取失败。` : '', missing ? `${missing} 张表尚未读取。` : '', truncated ? '表清单被宿主截断。' : ''].join('')
  const notice = notes ? `> 本文档包含 ${result.details.length}/${total} 张已加载表；${notes}\n\n` : ''
  return notice + renderSchemaMarkdown(title, result.details, dbType)
}
