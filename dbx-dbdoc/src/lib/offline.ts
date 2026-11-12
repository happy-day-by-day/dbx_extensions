import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate'
import type { DbxBridge, PluginContext } from './types'
import { runConcurrentQueue, type CatalogData, type ExportSchemaResult } from './store'
import { isConnectionNotOpen, isDataAccessDenied } from './bridge'
import type { DbTable } from './dialects/entities'
import type { TableDetail } from './markdown'
import { groupColumnMatches, type ColumnMatch } from './display/columnSearch'

export interface OfflineDocument {
  version: 1
  savedAt: number
  lastSyncedAt?: number
  catalog: CatalogData
  details: Record<string, { savedAt: number; value: TableDetail }>
}
export const offlineKey = (ctx: PluginContext) => `dbdoc.offline.v1.${JSON.stringify([ctx.connectionId, ctx.database ?? '', ctx.dbType])}`
export const offlineTableKey = (schema: string, table: string) => JSON.stringify([schema, table])

export async function loadOffline(bridge: DbxBridge, ctx: PluginContext): Promise<OfflineDocument | null> {
  try {
    const raw = await bridge.storageGet(offlineKey(ctx))
    if (!raw) return null
    const stored = JSON.parse(raw)
    const doc = stored?.encoding === 'gzip-base64'
      ? JSON.parse(strFromU8(gunzipSync(Uint8Array.from(atob(stored.data), (char) => char.charCodeAt(0)))))
      : stored
    if (doc?.version !== 1 || !Number.isFinite(doc.savedAt) || !Array.isArray(doc.catalog?.tables)
      || !doc.catalog.tables.every((t: any) => t && typeof t.table_name === 'string' && typeof t.table_schema === 'string')
      || !doc.details || typeof doc.details !== 'object' || Array.isArray(doc.details)) return null
    if (!Number.isFinite(doc.lastSyncedAt) || doc.lastSyncedAt <= 0) delete doc.lastSyncedAt
    for (const [key, entry] of Object.entries(doc.details) as [string, any][]) {
      if (!entry || !Number.isFinite(entry.savedAt) || !entry.value?.table
        || !Array.isArray(entry.value.columns) || !Array.isArray(entry.value.indexes) || !Array.isArray(entry.value.constraints)) delete doc.details[key]
    }
    return doc
  } catch { return null }
}

// Serialize writes so a slow older save cannot overwrite a newer table snapshot.
const writes = new WeakMap<DbxBridge, Promise<void>>()
function queueWrite(bridge: DbxBridge, action: () => Promise<void>): Promise<void> {
  const pending = (writes.get(bridge) ?? Promise.resolve()).catch(() => undefined).then(action)
  writes.set(bridge, pending)
  return pending.finally(() => { if (writes.get(bridge) === pending) writes.delete(bridge) })
}
export async function clearOffline(bridge: DbxBridge, ctx: PluginContext): Promise<void> {
  if (!ctx.connectionId || !ctx.database || !ctx.dbType) throw new Error('缺少数据库或连接信息，无法清除缓存')
  if (!bridge.storageDelete) throw new Error('当前插件不支持清除缓存，请更新插件后重试')
  await queueWrite(bridge, () => bridge.storageDelete!(offlineKey(ctx)))
}
export async function saveOffline(bridge: DbxBridge, ctx: PluginContext, doc: OfflineDocument, onError?: (message: string) => void): Promise<boolean> {
  if (!bridge.capabilities?.storage) return false
  const key = offlineKey(ctx)
  // Metadata repeats field names heavily. Compress before writing to the host's
  // persistent document files. Legacy UI-store values remain readable during migration.
  const compressed = gzipSync(strToU8(JSON.stringify(doc)))
  let binary = ''
  for (let i = 0; i < compressed.length; i += 8192) binary += String.fromCharCode(...compressed.subarray(i, i + 8192))
  const raw = JSON.stringify({ encoding: 'gzip-base64', data: btoa(binary) })
  const pending = queueWrite(bridge, () => bridge.storageSet(key, raw))
  try { await pending; return true } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err))
    return false
  }
}

export function withOfflineDetail(doc: OfflineDocument, detail: TableDetail): OfflineDocument {
  const key = offlineTableKey(detail.table.table_schema, detail.table.table_name)
  const details = { ...doc.details }
  delete details[key]
  details[key] = { savedAt: Date.now(), value: detail }
  return { ...doc, details }
}

// Read the entire catalog, independent of selection, search, and Schema filters.
// Stop dispatching on disconnection/denial, while retaining successfully read tables.
export interface OfflineSyncIssue { schema: string; table: string; messages: string[] }

export async function cacheAllTables(
  tables: DbTable[],
  load: (table: DbTable) => Promise<TableDetail>,
  options: {
    shouldContinue(): boolean
    onDetail(detail: TableDetail): Promise<void> | void
    onProgress(done: number, failed: number): void
    onIssue?(issue: OfflineSyncIssue): void
  }
): Promise<void> {
  let done = 0
  let failed = 0
  let stopped = false
  options.onProgress(0, 0)
  await runConcurrentQueue(tables, async (table) => {
    try {
      const detail = await load(table)
      if (!options.shouldContinue()) return
      await options.onDetail({ ...detail, table: { ...detail.table, ...table, column_count: detail.columns.length } })
      // Optional metadata failures are partial documents, never a complete sync.
      if (detail.warnings?.length) {
        failed += 1
        options.onIssue?.({ schema: table.table_schema, table: table.table_name, messages: detail.warnings })
      }
    } catch (err) {
      if (!options.shouldContinue()) return
      failed += 1
      options.onIssue?.({ schema: table.table_schema, table: table.table_name, messages: [err instanceof Error ? err.message : String(err)] })
      if (isConnectionNotOpen(err) || isDataAccessDenied(err)) stopped = true
    } finally {
      if (options.shouldContinue()) { done += 1; options.onProgress(done, failed) }
    }
  }, { concurrency: 2, shouldContinue: () => !stopped && options.shouldContinue() })
}

// Match cached metadata only: no bridge, storage reads, or database calls while typing.
export function searchOfflineColumnMatches(doc: OfflineDocument | null, keyword: string, schema: string | null = null): Map<string, ColumnMatch[]> {
  const term = keyword.trim().toLocaleLowerCase()
  if (!doc || !term) return new Map()
  const rows: Record<string, unknown>[] = []
  for (const table of doc.catalog.tables) {
    if (schema !== null && table.table_schema !== schema) continue
    const detail = doc.details[offlineTableKey(table.table_schema, table.table_name)]?.value
    for (const column of detail?.columns ?? []) {
      const name = String(column.column_name ?? '')
      const comment = String(column.column_comment ?? '')
      if (name.toLocaleLowerCase().includes(term) || comment.toLocaleLowerCase().includes(term)) {
        rows.push({ table_schema: table.table_schema, table_name: table.table_name, column_name: name, column_comment: comment })
      }
    }
  }
  return groupColumnMatches(rows)
}

// Use only the captured local document; a missing cache entry never triggers SQL.
export function exportOfflineSchema(doc: OfflineDocument | null, tables: DbTable[]): ExportSchemaResult {
  const result: ExportSchemaResult = { details: [], failed: [] }
  for (const table of tables) {
    const cached = doc?.details[offlineTableKey(table.table_schema, table.table_name)]?.value
    if (!cached) {
      result.failed.push({ schema: table.table_schema, table: table.table_name, message: '本地缓存缺失，未包含在导出文档中' })
      continue
    }
    result.details.push({ ...cached, table: { ...cached.table, ...table, column_count: cached.columns.length } })
  }
  return result
}

// The previous complete document is the only fallback; staged data is never
// persisted or returned on failure, cancellation, or incomplete metadata.
export function finishOfflineSync(doc: OfflineDocument, done: number, failed: number, persist: (document: OfflineDocument) => Promise<boolean>): Promise<OfflineDocument>
export function finishOfflineSync(doc: OfflineDocument, done: number, failed: number, persist: (document: OfflineDocument) => Promise<boolean>, previous: OfflineDocument | null, shouldContinue?: () => boolean): Promise<OfflineDocument | null>
export async function finishOfflineSync(
  doc: OfflineDocument, done: number, failed: number,
  persist: (document: OfflineDocument) => Promise<boolean>,
  previous: OfflineDocument | null = doc, shouldContinue: () => boolean = () => true
): Promise<OfflineDocument | null> {
  const complete = !doc.catalog.truncated && failed === 0 && done === doc.catalog.tables.length
    && doc.catalog.tables.every((table) => {
      const entry = doc.details[offlineTableKey(table.table_schema, table.table_name)]
      return entry && entry.savedAt >= doc.savedAt && !entry.value.warnings?.length
    })
  if (!complete || !shouldContinue()) return previous
  const candidate = { ...doc, lastSyncedAt: Date.now() }
  return await persist(candidate) && shouldContinue() ? candidate : previous
}
