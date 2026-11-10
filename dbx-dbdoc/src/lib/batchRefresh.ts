import type { DbxBridge, HostConnection, PluginContext } from './types'
import type { DocumentResource } from './resources'
import { getAdapter, normalizeDbType } from './dialects/registry'
import { loadCatalog, loadDetail } from './store'
import { loadOffline, saveOffline, cacheAllTables, withOfflineDetail, finishOfflineSync, type OfflineDocument } from './offline'
import { isConnectionNotOpen, isDataAccessDenied } from './bridge'
import { rememberConnection } from './recent'
import { maskUuids } from './display/masking'

export interface BatchTarget extends PluginContext {
  connectionId: string
  database: string
  name: string
  dbType: string
}
export type BatchState = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'
export interface BatchItem {
  key: string
  target: BatchTarget
  state: BatchState
  message: string
  done: number
  total: number
}
export const batchKey = (target: BatchTarget) => JSON.stringify([target.connectionId, target.database])

async function connections(bridge: DbxBridge): Promise<HostConnection[]> {
  if (!bridge.capabilities?.connectionsApi || !bridge.getConnections) throw new Error('当前 DBX 不支持读取连接状态，请升级 DBX 后使用批量生成')
  return bridge.getConnections()
}

export interface BatchDiscoveryIssue { connectionId: string; name: string; message: string }

function databaseListSql(dbType: string): string | undefined {
  if (dbType === 'postgres') return `SELECT datname AS database_name FROM pg_database
    WHERE datallowconn AND NOT datistemplate ORDER BY datname`
  return getAdapter(dbType)?.listDatabases?.({ db: null, schema: null, table: null })
}

async function readDatabaseNames(bridge: DbxBridge, connectionId: string, database: string | undefined, sql: string, dbType: string, shouldContinue: () => boolean): Promise<{ names: string[]; complete: boolean; issue?: string }> {
  const names: string[] = []
  const seen = new Set<string>()
  const limit = 5000
  let offset = 0
  while (shouldContinue()) {
    const paging = offset ? dbType === 'mssql' ? ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : ` LIMIT ${limit} OFFSET ${offset}` : ''
    let result
    try {
      result = await bridge.queryData({ connectionId, ...(database ? { database } : {}), sql: sql.trim().replace(/;$/, '') + paging, maxRows: limit })
    } catch (err) {
      if (!names.length) throw err
      return { names, complete: false, issue: maskUuids(err instanceof Error ? err.message : String(err)) }
    }
    const column = result.columns.findIndex((column) => column.name.toLowerCase() === 'database_name')
    if (column < 0) {
      if (!names.length) throw new Error('数据库目录响应缺少库名，无法完整枚举')
      return { names, complete: false, issue: '数据库目录响应缺少库名，无法完整枚举' }
    }
    const page = result.rows.map((row) => row[column]).filter((value): value is string => typeof value === 'string' && value.length > 0)
    const fresh = page.filter((name) => !seen.has(name))
    for (const name of fresh) { seen.add(name); names.push(name) }
    if (!result.truncated && result.rows.length < limit) return { names, complete: page.length === result.rows.length }
    if (!fresh.length || fresh.length !== page.length) return { names, complete: false }
    offset += result.rows.length
  }
  return { names, complete: false }
}

// Enumerate only explicitly connected connections, without opening any new session.
// Local documents are fallbacks, never a prerequisite for discovering or generating a database.
export async function discoverBatchTargets(bridge: DbxBridge, documents: DocumentResource[], options: {
  shouldContinue?: () => boolean
  onConnection?: (name: string, current: number, total: number) => void
  onIssue?: (issue: BatchDiscoveryIssue) => void
} = {}): Promise<BatchTarget[]> {
  const targets = new Map<string, BatchTarget>()
  const active = options.shouldContinue ?? (() => true)
  const connected = (await connections(bridge)).filter((connection) => connection.connected)
  for (const [index, connection] of connected.entries()) {
    if (!active()) break
    const known = documents.filter((document) => document.connection.connectionId === connection.connectionId)
    const name = connection.name || known[0]?.connection.name || '未命名连接'
    const dbType = normalizeDbType(connection.dbType || known[0]?.connection.dbType || '')
    const databases = new Set([...known.map((document) => document.database), connection.database].filter((value): value is string => Boolean(value)))
    options.onConnection?.(name, index + 1, connected.length)
    const sql = databaseListSql(dbType)
    let issue = ''
    if (sql) {
      // No database means the host's existing base session. Fall back to known
      // exact sessions only if that base session is closed; never reconnect.
      for (const session of [undefined, ...databases]) {
        if (!active()) break
        try {
          const result = await readDatabaseNames(bridge, connection.connectionId, session, sql, dbType, active)
          for (const database of result.names) databases.add(database)
          issue = result.complete ? '' : `${result.issue ? result.issue + '；' : ''}数据库目录未能完整读取；已发现及已知的数据库仍可生成`
          break
        } catch (err) {
          issue = maskUuids(err instanceof Error ? err.message : String(err))
          if (!isConnectionNotOpen(err)) break
        }
      }
    } else issue = '暂不支持此类型的数据库目录；仅保留已知数据库'
    if (!active()) break
    if (issue) options.onIssue?.({ connectionId: connection.connectionId, name, message: issue })
    for (const database of databases) {
      const target = { connectionId: connection.connectionId, name, dbType: dbType === 'unknown' ? connection.dbType : dbType, database }
      targets.set(batchKey(target), target)
    }
  }
  return [...targets.values()]
}

export function createBatchItems(targets: BatchTarget[]): BatchItem[] {
  return targets.map((target) => ({ key: batchKey(target), target, state: 'pending', message: '等待生成', done: 0, total: 0 }))
}

// Process databases sequentially; the bridge still enforces the shared four-query limit.
// Stop requests finish the current database, then leave all remaining snapshots untouched.
export async function refreshBatch(
  bridge: DbxBridge, targets: BatchTarget[],
  options: { shouldContinue(): boolean; onUpdate(item: BatchItem): void; onCommitted?(target: BatchTarget): void }
): Promise<BatchItem[]> {
  const results: BatchItem[] = []
  for (const target of targets) {
    let item = createBatchItems([target])[0]
    const update = (patch: Partial<BatchItem>) => { item = { ...item, ...patch }; options.onUpdate(item) }
    if (!options.shouldContinue()) {
      update({ state: 'cancelled', message: '已停止，保留原缓存' }); results.push(item); continue
    }
    update({ state: 'running', message: '确认数据库会话…' })
    try {
      if (!bridge.capabilities?.storage) throw new Error('当前 DBX 不支持保存本地缓存')
      if (!(await connections(bridge)).some((connection) => connection.connectionId === target.connectionId && connection.connected)) {
        update({ state: 'skipped', message: '连接未建立，已跳过' }); results.push(item); continue
      }
      const probe = await bridge.queryData({ connectionId: target.connectionId, database: target.database, sql: 'SELECT 1', maxRows: 1 })
      const dbType = normalizeDbType(target.dbType || probe.dbType)
      const adapter = getAdapter(dbType)
      if (!adapter) {
        update({ state: 'skipped', message: '暂不支持此数据库类型的整库文档' }); results.push(item); continue
      }
      const context = { ...target, dbType }
      const previous = await loadOffline(bridge, context)
      const ref = { db: target.database, schema: null, table: null }
      update({ message: '读取表目录…' })
      const catalog = await loadCatalog(bridge, adapter, target.connectionId, ref)
      let staged: OfflineDocument = { version: 1, savedAt: Date.now(), catalog, details: {} }
      let done = 0
      let failed = 0
      let firstIssue = ''
      update({ total: catalog.tables.length, message: '读取整库文档…' })
      await cacheAllTables(catalog.tables,
        (table) => loadDetail(bridge, adapter, target.connectionId, ref, table.table_schema, table.table_name), {
          shouldContinue: () => true,
          onDetail: (detail) => { staged = withOfflineDetail(staged, detail) },
          onIssue: (issue) => { if (!firstIssue) firstIssue = `${issue.schema}.${issue.table}：${issue.messages.join('；')}` },
          onProgress: (processed, failures) => { done = processed; failed = failures; update({ done, message: `已读取 ${done} / ${catalog.tables.length} 张表` }) }
        })
      let storageError = ''
      const committed = await finishOfflineSync(staged, done, failed,
        (document) => saveOffline(bridge, context, document, (message) => { storageError = message }), previous)
      if (!committed || committed === previous) {
        throw new Error(storageError || (catalog.truncated ? '表目录不完整' : firstIssue || '整库文档未能完整读取'))
      }
      // Cache persistence is the commit boundary. A recent-list failure cannot undo a successful sync.
      await rememberConnection(bridge, context).catch(() => undefined)
      update({ state: 'success', message: `${previous ? '已更新' : '已生成'} ${catalog.tables.length} 张表` })
      options.onCommitted?.(context)
    } catch (err) {
      const message = maskUuids(err instanceof Error ? err.message : String(err))
      update({ state: isConnectionNotOpen(err) ? 'skipped' : 'failed',
        message: isConnectionNotOpen(err) ? '数据库会话未打开，已跳过' : `${isDataAccessDenied(err) ? '查询未授权' : message}；保留原缓存` })
    }
    results.push(item)
  }
  return results
}
