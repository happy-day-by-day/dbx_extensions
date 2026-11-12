import { loadOffline, type OfflineDocument } from './offline'
import { loadRecent, type RecentConnection } from './recent'
import type { DbxBridge, PluginContext } from './types'
import { cleanConnectionName, connectionLabel } from './connectionLabels'
import { getAdapter, normalizeDbType } from './dialects/registry'
import { runConcurrentQueue } from './store'

export interface ResourceConnection {
  connectionId: string
  name: string
  dbType: string
  databases: string[]
  lastUsed: number
}

// 同一连接的历史数据库归到一行；当前上下文的名称和类型优先于历史记录。
export function groupConnections(recent: RecentConnection[], context: PluginContext = {}): ResourceConnection[] {
  const groups = new Map<string, ResourceConnection>()
  for (const entry of [...recent].sort((a, b) => b.ts - a.ts)) {
    let group = groups.get(entry.connectionId)
    if (!group) {
      group = { connectionId: entry.connectionId, name: cleanConnectionName(entry.name, entry.connectionId), dbType: entry.dbType, databases: [], lastUsed: entry.ts }
      groups.set(entry.connectionId, group)
    }
    if (!group.name) group.name = cleanConnectionName(entry.name, entry.connectionId)
    if (!group.dbType) group.dbType = entry.dbType
    if (entry.database && !group.databases.includes(entry.database)) group.databases.push(entry.database)
  }
  if (context.connectionId) {
    const active = groups.get(context.connectionId) ?? { connectionId: context.connectionId, name: '', dbType: '', databases: [], lastUsed: 0 }
    active.name = cleanConnectionName(context.name, context.connectionId) || active.name
    active.dbType = context.dbType || active.dbType
    if (context.database) active.databases = [context.database, ...active.databases.filter((database) => database !== context.database)]
    groups.delete(active.connectionId)
    return [active, ...groups.values()]
  }
  return [...groups.values()]
}

export interface DocumentResource {
  key: string
  connection: ResourceConnection
  database: string
}

// A row belongs to an exact connection/database pair, including identically named databases.
export function documentResources(connections: ResourceConnection[], refreshed?: { connectionId: string; databases: string[] }): DocumentResource[] {
  return connections.flatMap((connection) => {
    const databases = refreshed?.connectionId === connection.connectionId
      ? mergeDatabases(connection.databases, refreshed.databases) : connection.databases
    const adapter = getAdapter(connection.dbType)
    // Historical entries and recovered snapshot indexes can predate discovery
    // exclusions. Apply the same policy before rendering or reading summaries.
    return databases.filter((database) => !adapter?.isSystemDatabase?.(database))
      .map((database) => ({ key: JSON.stringify([connection.connectionId, database]), connection, database }))
  })
}

export function mergeDatabases(known: string[], available: string[]): string[] {
  return [...new Set([...known, ...available].filter(Boolean))]
}

export function connectionMatches(connection: ResourceConnection, keyword: string): boolean {
  const query = keyword.trim().toLocaleLowerCase()
  return !query || [connectionLabel(connection), connection.name, connection.dbType, ...connection.databases].some((value) => value.toLocaleLowerCase().includes(query))
}

// 最近库名仅用于展示，不代表 Host 中仍有对应会话。列表读取只使用当前上下文或连接默认会话。
export function currentSessionDatabase(context: PluginContext, connectionId: string): string | undefined {
  return context.connectionId === connectionId ? context.database || undefined : undefined
}

// 用户点击数据库时确认精确目标会话；失败保留在选择器，不切换或隐式连接其他数据库。
export async function verifyDatabaseSession(bridge: DbxBridge, connectionId: string, database?: string): Promise<void> {
  await bridge.queryData({ connectionId, ...(database ? { database } : {}), sql: 'SELECT 1', maxRows: 1 })
}

export interface DocumentCacheSummary {
  state: 'ready' | 'partial' | 'missing'
  tableCount: number
  cachedTableCount: number
  lastSyncedAt: number | null
}

// Summaries describe cached documentation, never database connection status.
export function summarizeDocumentCache(doc: OfflineDocument | null): DocumentCacheSummary {
  if (!doc) return { state: 'missing', tableCount: 0, cachedTableCount: 0, lastSyncedAt: null }
  const entries = doc.catalog.tables.map((table) => doc.details[JSON.stringify([table.table_schema, table.table_name])])
  const count = entries.filter(Boolean).length
  const complete = !doc.catalog.truncated && entries.every((entry) => entry && entry.savedAt >= doc.savedAt && !entry.value.warnings?.length)
  return { state: complete ? 'ready' : 'partial', tableCount: entries.length, cachedTableCount: count, lastSyncedAt: doc.lastSyncedAt ?? null }
}

// Refreshing the picker only reloads local records and cache summaries, never database sessions.
export async function loadLocalDocumentList(bridge: DbxBridge | null, context: PluginContext = {}) {
  const recent = await loadRecent(bridge)
  const documents = documentResources(groupConnections(recent, context))
  const cacheEntries = new Map<string, DocumentCacheSummary>()
  if (bridge?.capabilities?.storage) {
    await runConcurrentQueue(documents, async ({ key, connection, database }) => {
      const doc = await loadOffline(bridge, { connectionId: connection.connectionId, database, dbType: normalizeDbType(connection.dbType) })
      cacheEntries.set(key, summarizeDocumentCache(doc))
    }, { concurrency: 4 })
  }
  return { recent, cacheEntries }
}
