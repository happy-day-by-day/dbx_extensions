import type { RecentConnection } from './recent'
import type { DbxBridge, PluginContext } from './types'
import { cleanConnectionName, connectionLabel } from './connectionLabels'

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
