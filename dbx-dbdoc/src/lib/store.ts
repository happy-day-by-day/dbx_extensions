// 会话缓存 / 目录与详情加载器 / 并发导出队列（Task 10）。
// 加载器签名按控制器裁定带 connectionId 首参（TableRef 不含连接信息），
// runConcurrentQueue 自 data-watcher databaseConcurrentQueue.mjs 逐行移植（行为不变）。
import type { DbxBridge } from './types'
import type { DialectAdapter, TableRef } from './dialects/types'
import type { DbColumn, DbConstraint, DbIndex, DbTable } from './dialects/entities'
import { rowsToObjects } from './dialects/shared'
import { isDataAccessDenied, isConnectionNotOpen } from './bridge'
import type { TableDetail } from './markdown'

const MAX_ROWS = 5000

// 会话缓存键：连接 + 库 + schema 唯一定位一份目录/详情。
export const connKeyOf = (connectionId: string, ref: TableRef): string =>
  JSON.stringify([connectionId, ref.db ?? '', ref.schema ?? ''])

export interface CatalogData {
  tables: DbTable[]
  truncated: boolean
}

export interface SessionCache {
  catalog(connKey: string): CatalogData | undefined
  setCatalog(connKey: string, value: CatalogData): void
  detail(connKey: string, schema: string, table: string): TableDetail | undefined
  setDetail(connKey: string, schema: string, table: string, value: TableDetail): void
  clear(connKey: string): void
  version(connKey: string): number
}

export function createSessionCache(detailLimit = 64, catalogLimit = 8): SessionCache {
  const catalogs = new Map<string, CatalogData>()
  const details = new Map<string, { connKey: string; value: TableDetail }>()
  const detailKey = (connKey: string, schema: string, table: string): string => JSON.stringify([connKey, schema, table])
  const versions = new Map<string, number>()
  const clear = (connKey: string) => {
    catalogs.delete(connKey)
    for (const [key, entry] of details) if (entry.connKey === connKey) details.delete(key)
    versions.set(connKey, (versions.get(connKey) ?? 0) + 1)
  }
  return {
    catalog: (connKey) => {
      const value = catalogs.get(connKey)
      if (value) { catalogs.delete(connKey); catalogs.set(connKey, value) }
      return value
    },
    setCatalog: (connKey, value) => {
      catalogs.delete(connKey)
      catalogs.set(connKey, value)
      while (catalogs.size > Math.max(1, catalogLimit)) clear(catalogs.keys().next().value!)
    },
    detail: (connKey, schema, table) => {
      const key = detailKey(connKey, schema, table)
      const entry = details.get(key)
      if (entry) { details.delete(key); details.set(key, entry) }
      return entry?.value
    },
    setDetail: (connKey, schema, table, value) => {
      const key = detailKey(connKey, schema, table)
      details.delete(key)
      details.set(key, { connKey, value })
      while (details.size > Math.max(1, detailLimit)) details.delete(details.keys().next().value!)
    },
    clear,
    version: (connKey) => versions.get(connKey) ?? 0
  }
}

// 每次目录查询统一携带 connectionId 与 maxRows。
const runQuery = async (
  bridge: DbxBridge,
  connectionId: string,
  ref: TableRef,
  sql: string,
  onTruncated?: () => void
): Promise<Record<string, unknown>[]> => {
  const result = await bridge.queryData({
      connectionId,
      database: ref.db ?? undefined,
      schema: ref.schema ?? undefined,
      sql,
      maxRows: MAX_ROWS
    })
  if (result.truncated) onTruncated?.()
  return rowsToObjects(result)
}

// 能力检测按宿主桥和连接/库隔离；并发导出共用在途检测，错误不会缓存。
const checkSupportCache = new WeakMap<DbxBridge, Map<string, Promise<boolean>>>()
async function supportsCheckConstraints(bridge: DbxBridge, adapter: DialectAdapter, connectionId: string, ref: TableRef): Promise<boolean> {
  if (!adapter.probeCheckConstraints) return true
  let entries = checkSupportCache.get(bridge)
  if (!entries) { entries = new Map(); checkSupportCache.set(bridge, entries) }
  const key = JSON.stringify([adapter.dbType, connectionId, ref.db])
  let pending = entries.get(key)
  if (!pending) {
    pending = runQuery(bridge, connectionId, ref, adapter.probeCheckConstraints()).then((rows) => {
      const available = Number(rows[0]?.available)
      if (rows.length !== 1 || !Number.isInteger(available) || available < 0) throw new Error('检查约束能力检测未返回有效结果')
      return available > 0
    })
    entries.set(key, pending)
    while (entries.size > 8) entries.delete(entries.keys().next().value!)
  } else { entries.delete(key); entries.set(key, pending) }
  try { return await pending } catch (err) {
    if (entries.get(key) === pending) entries.delete(key)
    throw err
  }
}

export async function loadCatalog(
  bridge: DbxBridge,
  adapter: DialectAdapter,
  connectionId: string,
  ref: TableRef,
  cache?: SessionCache
): Promise<CatalogData> {
  const connKey = connKeyOf(connectionId, ref)
  const cached = cache?.catalog(connKey)
  if (cached) return cached
  const version = cache?.version(connKey)
  const query = await bridge.queryData({
    connectionId,
    database: ref.db ?? undefined,
    schema: ref.schema ?? undefined,
    sql: adapter.listTables(ref),
    maxRows: MAX_ROWS
  })
  const data: CatalogData = { tables: rowsToObjects(query).map(adapter.mapTable), truncated: query.truncated }
  if (cache?.version(connKey) === version) cache?.setCatalog(connKey, data)
  return data
}

// 索引查询失败（旧版本 MySQL 无 EXPRESSION 列）时回退 legacy SQL 重试；
// 授权被拒不是方言兼容问题，直接上抛不重试。
const loadIndexRows = async (
  bridge: DbxBridge,
  adapter: DialectAdapter,
  connectionId: string,
  ref: TableRef,
  table: string,
  onTruncated?: () => void
): Promise<Record<string, unknown>[]> => {
  try {
    return await runQuery(bridge, connectionId, ref, adapter.listIndexes(ref, table), onTruncated)
  } catch (error) {
    if (isDataAccessDenied(error)) throw error
    if (typeof adapter.listIndexesLegacy === 'function') {
      return await runQuery(bridge, connectionId, ref, adapter.listIndexesLegacy(ref, table), onTruncated)
    }
    throw error
  }
}

export async function loadDetail(
  bridge: DbxBridge,
  adapter: DialectAdapter,
  connectionId: string,
  ref: TableRef,
  schema: string,
  table: string,
  cache?: SessionCache
): Promise<TableDetail> {
  const connKey = connKeyOf(connectionId, ref)
  const cached = cache?.detail(connKey, schema, table)
  if (cached) return cached
  const version = cache?.version(connKey)

  // 详情查询以目标 schema 为准（ref.schema 是目录级过滤，可能为 null）：
  // pg/mssql 的详情 SQL 依赖 ref.schema 做等值过滤，不叠加会导致多 schema 库
  // 同名表的详情跨 schema 合并；mysql 的 SQL 忽略 schema 不受影响。
  const detailRef: TableRef = { ...ref, schema: schema || ref.schema }

  const warnings: string[] = []
  let checksSupported: boolean | undefined
  const loadChecks = async () => {
    checksSupported = await supportsCheckConstraints(bridge, adapter, connectionId, detailRef)
    if (!checksSupported) return []
    return runQuery(bridge, connectionId, detailRef, adapter.listChecks(detailRef, table), () => warnings.push('检查约束列表被宿主截断'))
  }
  const optional = async (label: string, task: Promise<Record<string, unknown>[]>) => {
    try { return await task } catch (err) {
      if (isDataAccessDenied(err)) throw err
      warnings.push(`${label}未能读取：${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }
  const [columns, indexRows, fkRows, checkRows] = await Promise.all([
    runQuery(bridge, connectionId, detailRef, adapter.listColumns(detailRef, table), () => warnings.push('字段列表被宿主截断')),
    optional('索引', loadIndexRows(bridge, adapter, connectionId, detailRef, table, () => warnings.push('索引列表被宿主截断'))),
    optional('外键', runQuery(bridge, connectionId, detailRef, adapter.listForeignKeys(detailRef, table), () => warnings.push('外键列表被宿主截断'))),
    optional('检查约束', loadChecks())
  ])

  const mappedColumns: DbColumn[] = columns.map(adapter.mapColumn)
  const indexes: DbIndex[] = indexRows.map(adapter.mapIndex)
  const constraints: DbConstraint[] = [
    ...fkRows.map((row) => ({ ...adapter.mapConstraint(row), constraint_type: 'FOREIGN KEY' })),
    ...checkRows.map((row) => ({ ...adapter.mapConstraint(row), constraint_type: 'CHECK' }))
  ]
  const detail: TableDetail = {
    table: {
      table_schema: schema,
      table_name: table,
      table_comment: '',
      engine: '',
      table_collation: '',
      column_count: mappedColumns.length
    },
    columns: mappedColumns,
    indexes,
    constraints,
    warnings,
    checksSupported
  }
  if (cache?.version(connKey) === version) cache?.setDetail(connKey, schema, table, detail)
  return detail
}

export async function searchColumnHits(
  bridge: DbxBridge,
  adapter: DialectAdapter,
  connectionId: string,
  ref: TableRef,
  keyword: string,
  onTruncated?: () => void
): Promise<Set<string>> {
  const rows = await runQuery(bridge, connectionId, ref, adapter.searchColumns(ref, keyword), onTruncated)
  return new Set(rows.map((row) => `${String(row.table_schema ?? '')}.${String(row.table_name ?? '')}`))
}

// 未实现枚举的方言返回空列表；选择器使用 strict 保留读取错误以显示重试入口。
export async function listDatabases(
  bridge: DbxBridge,
  adapter: DialectAdapter,
  connectionId: string,
  ref: TableRef,
  strict = false
): Promise<string[]> {
  if (typeof adapter.listDatabases !== 'function') return []
  try {
    const rows = await runQuery(bridge, connectionId, ref, adapter.listDatabases(ref))
    return rows.map((row) => String(row.database_name ?? '')).filter((name) => name !== '')
  } catch (err) {
    if (strict || isDataAccessDenied(err)) throw err
    return []
  }
}

export interface ExportSchemaOptions {
  concurrency: number
  onProgress(done: number, total: number): void
  shouldContinue(): boolean
}

export interface ExportSchemaResult {
  details: TableDetail[]
  failed: Array<{ schema: string; table: string; message: string }>
}

export async function exportSchema(
  bridge: DbxBridge,
  adapter: DialectAdapter,
  connectionId: string,
  ref: TableRef,
  tables: DbTable[],
  opts: ExportSchemaOptions
): Promise<ExportSchemaResult> {
  const list = Array.isArray(tables) ? tables : []
  const slots: (TableDetail | undefined)[] = new Array(list.length).fill(undefined)
  const failed: ExportSchemaResult['failed'] = []
  // 授权被拒或会话关闭时停止入队；其他单表错误不阻塞剩余表。
  let aborted = false
  let done = 0
  opts.onProgress(0, list.length)
  await runConcurrentQueue(
    list,
    async (table, index) => {
      const schema = String(table?.table_schema ?? '')
      const name = String(table?.table_name ?? '')
      try {
        const detail = await loadDetail(bridge, adapter, connectionId, ref, schema, name)
        // loadDetail 的查询不含表注释/引擎/排序规则，用 catalog 行的非空元数据补齐，
        // 保证导出文档的表标题与摘要信息完整。
        slots[index] = {
          ...detail,
          table: {
            ...detail.table,
            table_comment: table?.table_comment || detail.table.table_comment,
            engine: table?.engine || detail.table.engine,
            table_collation: table?.table_collation || detail.table.table_collation
          }
        }
      } catch (err) {
        failed.push({ schema, table: name, message: err instanceof Error ? err.message : String(err) })
        if (isDataAccessDenied(err) || isConnectionNotOpen(err)) aborted = true
      }
    },
    {
      concurrency: opts.concurrency,
      shouldContinue: () => !aborted && opts.shouldContinue(),
      onSettled: () => {
        done += 1
        opts.onProgress(done, list.length)
      }
    }
  )
  return { details: slots.filter((detail): detail is TableDetail => Boolean(detail)), failed }
}

export interface Loaders {
  loadCatalog(bridge: DbxBridge, adapter: DialectAdapter, connectionId: string, ref: TableRef): Promise<CatalogData>
  loadDetail(bridge: DbxBridge, adapter: DialectAdapter, connectionId: string, ref: TableRef, schema: string, table: string): Promise<TableDetail>
  searchColumnHits(bridge: DbxBridge, adapter: DialectAdapter, connectionId: string, ref: TableRef, keyword: string): Promise<Set<string>>
  exportSchema(bridge: DbxBridge, adapter: DialectAdapter, connectionId: string, ref: TableRef, tables: DbTable[], opts: ExportSchemaOptions): Promise<ExportSchemaResult>
}

// —— 并发队列：自 data-watcher apps/web/src/views/database/composables/databaseConcurrentQueue.mjs 逐行移植 ——

export interface QueueSettledResult<T> {
  item: T
  index: number
  status: 'fulfilled' | 'rejected'
  value: unknown
}

export interface ConcurrentQueueOptions<T> {
  concurrency?: number
  shouldContinue?(): boolean
  onSettled?(result: QueueSettledResult<T>): void
}

export async function runConcurrentQueue<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  options: ConcurrentQueueOptions<T> = {}
): Promise<void> {
  const queue = Array.isArray(items) ? items : []
  if (!queue.length) {
    return
  }

  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 1, queue.length))
  const shouldContinue = options.shouldContinue || (() => true)
  const onSettled = options.onSettled || (() => undefined)
  let nextIndex = 0

  const runWorker = async (): Promise<void> => {
    while (nextIndex < queue.length && shouldContinue()) {
      const index = nextIndex++
      let status: 'fulfilled' | 'rejected' = 'fulfilled'
      let value: unknown
      try {
        value = await worker(queue[index], index)
      } catch (error) {
        status = 'rejected'
        value = error
      }
      onSettled({ item: queue[index], index, status, value })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runWorker))
}
