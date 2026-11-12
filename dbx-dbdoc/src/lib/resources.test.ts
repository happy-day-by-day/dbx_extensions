import { describe, expect, it, vi } from 'vitest'
import { connectionMatches, groupConnections, documentResources, mergeDatabases, currentSessionDatabase, summarizeDocumentCache, loadLocalDocumentList, verifyDatabaseSession } from './resources'
import type { DbxBridge } from './types'
import { offlineKey, type OfflineDocument } from './offline'
import type { RecentConnection } from './recent'
import { cleanConnectionName, connectionLabel, connectionSubtitle } from './connectionLabels'

const recent: RecentConnection[] = [
  { connectionId: 'a', name: '旧名称', dbType: 'mysql', database: 'shop', ts: 10 },
  { connectionId: 'b', name: '数据分析', dbType: 'postgres', database: 'shop', ts: 30 },
  { connectionId: 'a', name: '业务开发', dbType: 'mysql', database: 'reporting', ts: 40 },
  { connectionId: 'a', name: '', dbType: '', database: 'shop', ts: 20 }
]

describe('资源选择器', () => {
  it('同一连接归为一行，按最近使用排序，数据库去重且不跨连接混合', () => {
    const original = JSON.stringify(recent)
    expect(groupConnections(recent)).toEqual([
      { connectionId: 'a', name: '业务开发', dbType: 'mysql', databases: ['reporting', 'shop'], lastUsed: 40 },
      { connectionId: 'b', name: '数据分析', dbType: 'postgres', databases: ['shop'], lastUsed: 30 }
    ])
    expect(JSON.stringify(recent)).toBe(original)
  })

  it('平铺所有连接的数据库，同名数据库保留各自的名称、类型和独立缓存键', () => {
    const documents = documentResources(groupConnections(recent))
    expect(documents.map(({ connection, database }) => [connection.connectionId, connection.name, connection.dbType, database])).toEqual([
      ['a', '业务开发', 'mysql', 'reporting'],
      ['a', '业务开发', 'mysql', 'shop'],
      ['b', '数据分析', 'postgres', 'shop']
    ])
    const cache = new Map(documents.map((document) => [document.key, document.connection.name]))
    expect(cache.size).toBe(3)
    expect(cache.get(documents[1].key)).toBe('业务开发')
    expect(cache.get(documents[2].key)).toBe('数据分析')
  })

  it('刷新当前连接合并新库，保留其他连接的文档，且不修改历史记录', () => {
    const connections = groupConnections(recent)
    const original = JSON.stringify(connections)
    const documents = documentResources(connections, { connectionId: 'a', databases: ['shop', 'new_db'] })
    expect(documents.map(({ connection, database }) => [connection.connectionId, database])).toEqual([
      ['a', 'reporting'], ['a', 'shop'], ['a', 'new_db'], ['b', 'shop']
    ])
    expect(JSON.stringify(connections)).toBe(original)
    expect(documentResources([])).toEqual([])
  })
  it('本地历史、当前上下文及合并列表都排除系统库，保留相似业务库和其他类型的同名库', () => {
    const entries = [
      { connectionId: 'cloud', name: '海南 / 全部库-TEST', dbType: 'MariaDB', database: '__cdb_recycle_bin__', ts: 10 },
      { connectionId: 'cloud', name: '海南 / 全部库-TEST', dbType: 'MariaDB', database: '__cdb_recycle_bin___backup', ts: 9 },
      { connectionId: 'pg', name: 'PG', dbType: 'postgres', database: '__cdb_recycle_bin__', ts: 8 }
    ]
    const before = JSON.stringify(entries)
    const groups = groupConnections(entries, { connectionId: 'cloud', dbType: 'mysql', database: '__CDB_RECYCLE_BIN__' })
    const resources = documentResources(groups, { connectionId: 'cloud', databases: ['sys', '__cdb_recycle_bin__', 'shop'] })
    expect(resources.map(({ connection, database }) => [connection.connectionId, database])).toEqual([
      ['cloud', '__cdb_recycle_bin___backup'], ['cloud', 'shop'], ['pg', '__cdb_recycle_bin__']
    ])
    expect(documentResources(groupConnections([entries[0]]))).toEqual([])
    expect(JSON.stringify(entries)).toBe(before)
  })

  it('当前连接置顶并使用实时上下文名称、类型和数据库', () => {
    const groups = groupConnections(recent, { connectionId: 'b', name: '实时名称', dbType: 'postgresql', database: 'events' })
    expect(groups[0]).toEqual({ connectionId: 'b', name: '实时名称', dbType: 'postgresql', databases: ['events', 'shop'], lastUsed: 30 })
    expect(groups[1].connectionId).toBe('a')
  })

  it('首次从右键打开的连接无需已有历史记录', () => {
    expect(groupConnections([], { connectionId: 'new', database: 'appdb' })).toEqual([
      { connectionId: 'new', name: '', dbType: '', databases: ['appdb'], lastUsed: 0 }
    ])
  })

  it('当前上下文名称为空、占位或机器 ID 时不覆盖已有真实名称', () => {
    for (const name of ['', '未命名连接', 'a']) {
      expect(groupConnections(recent, { connectionId: 'a', name })[0].name).toBe('业务开发')
    }
  })

  it('主标题显示库名，不拼接类型，没有库名与有效连接名称时用序号', () => {
    expect(connectionLabel({ connectionId: 'a', dbType: 'mysql', databases: ['shop', 'reporting'] })).toBe('shop')
    expect(connectionLabel({ connectionId: 'b', dbType: 'postgres', database: 'analytics' })).toBe('analytics')
    expect(connectionLabel({ connectionId: 'c', dbType: 'mysql' }, 3)).toBe('数据库连接 3')
    expect(connectionLabel({ connectionId: 'd' }, 4)).toBe('数据库连接 4')
  })

  it('真实名称透传并清理空格，仅过滤占位名和明确机器标识', () => {
    expect(cleanConnectionName(' Health_MySQL_2026_TEST ', 'a')).toBe('Health_MySQL_2026_TEST')
    expect(cleanConnectionName('V1StGXR8Z5jdHi6BmyTqPz', 'V1StGXR8Z5jdHi6BmyTqPz')).toBe('')
    expect(cleanConnectionName('a3f9c2e1-1111-2222-3333-444455556666')).toBe('')
    expect(cleanConnectionName('未命名连接')).toBe('')
    expect(connectionLabel({ name: 'Health_MySQL_2026_TEST', dbType: 'mysql', database: 'shop' })).toBe('shop')
    expect(connectionSubtitle({ name: 'Health_MySQL_2026_TEST', dbType: 'mysql', database: 'shop' })).toBe('Health_MySQL_2026_TEST')
  })

  it('当前库名优先于最近库与连接名，表名不用于主标题或辅助名称', () => {
    const ctx = { connectionId: 'a', dbType: 'mysql', name: 'orders', database: 'shop', databases: ['reporting'], table: 'orders' }
    expect(connectionLabel(ctx)).toBe('shop')
    expect(connectionSubtitle(ctx)).toBe('')
    expect(connectionLabel({ ...ctx, database: undefined, databases: [] }, 1)).toBe('数据库连接 1')
    expect(connectionSubtitle({ ...ctx, name: 'shop' })).toBe('')
    expect(connectionLabel({ ...ctx, database: 'Health_MySQL_2026_TEST' })).toBe('Health_MySQL_2026_TEST')
    expect(connectionLabel({ ...ctx, database: '0f9e8d7c6b5a4321' })).toBe('0f9e8d7c6b5a4321')
  })

  it('连接搜索同时匹配名称、数据库类型和已知数据库', () => {
    const group = groupConnections(recent)[0]
    expect(connectionMatches(group, '开发')).toBe(true)
    expect(connectionMatches(group, ' MYSQL ')).toBe(true)
    expect(connectionMatches(group, 'REPORT')).toBe(true)
    expect(connectionMatches(group, 'events')).toBe(false)
  })

  it('历史数据库与实时列表合并，保留最近顺序并移除空名和重复项', () => {
    expect(mergeDatabases(['shop', 'reporting'], ['reporting', '', 'support', 'shop'])).toEqual(['shop', 'reporting', 'support'])
  })

  it('数据库列表只采用同一连接的当前上下文，不借用其他连接或历史库的会话', () => {
    expect(currentSessionDatabase({ connectionId: 'a', database: 'active' }, 'a')).toBe('active')
    expect(currentSessionDatabase({ connectionId: 'a', database: 'active' }, 'b')).toBeUndefined()
    expect(currentSessionDatabase({ connectionId: 'a' }, 'a')).toBeUndefined()
  })

  it('打开数据库前确认精确目标，会话确认仅执行一条只读查询', async () => {
    const queryData = vi.fn().mockResolvedValue({ rows: [[1]] })
    await verifyDatabaseSession({ queryData } as unknown as DbxBridge, 'a', 'target')
    expect(queryData).toHaveBeenCalledTimes(1)
    expect(queryData).toHaveBeenCalledWith({ connectionId: 'a', database: 'target', sql: 'SELECT 1', maxRows: 1 })
  })

  it('当前默认会话未指定数据库时不写入猜测库名', async () => {
    const queryData = vi.fn().mockResolvedValue({ rows: [[1]] })
    await verifyDatabaseSession({ queryData } as unknown as DbxBridge, 'a')
    expect(queryData).toHaveBeenCalledTimes(1)
    expect(queryData).toHaveBeenCalledWith({ connectionId: 'a', sql: 'SELECT 1', maxRows: 1 })
  })

  it.each(['Connection is not open', 'PLUGIN_DATA_ACCESS_NOT_GRANTED'])('会话错误不改查其他数据库：%s', async (message) => {
    const error = new Error(message)
    const queryData = vi.fn().mockRejectedValue(error)
    await expect(verifyDatabaseSession({ queryData } as unknown as DbxBridge, 'a', 'closed')).rejects.toBe(error)
    expect(queryData).toHaveBeenCalledTimes(1)
    expect(queryData).toHaveBeenCalledWith(expect.objectContaining({ database: 'closed' }))
  })
})

describe('document picker cache summaries', () => {
  const table = (schema: string) => ({ table_schema: schema, table_name: 'orders', table_comment: '', engine: '', table_collation: '', column_count: 0 })
  const document = (): OfflineDocument => ({ version: 1, savedAt: 100, lastSyncedAt: 200,
    catalog: { tables: ['a', 'b'].map(table), truncated: false },
    details: Object.fromEntries(['a', 'b'].map((schema) => [JSON.stringify([schema, 'orders']), {
      savedAt: 150, value: { table: table(schema), columns: [], indexes: [], constraints: [], warnings: [] }
    }])) as OfflineDocument['details'] })
  it.each([false, true])('刷新本地历史不显示回收站，无论是否仍有旧缓存：%s', async cached => {
    const entries = [
      { connectionId: 'cloud', name: '海南 / 全部库-TEST', dbType: 'mysql', database: '__cdb_recycle_bin__', ts: 10 },
      { connectionId: 'cloud', name: '海南 / 全部库-TEST', dbType: 'mysql', database: 'shop', ts: 9 }
    ]
    const recycleKey = offlineKey(entries[0])
    const storage = new Map([['dbdoc.recent', JSON.stringify(entries)]])
    if (cached) storage.set(recycleKey, JSON.stringify(document()))
    const bridge = {
      capabilities: { storage: true }, storageGet: vi.fn(async (key: string) => storage.get(key) ?? null),
      storageSet: vi.fn(), queryData: vi.fn(), getConnections: vi.fn()
    }
    for (let refresh = 0; refresh < 2; refresh++) {
      const snapshot = await loadLocalDocumentList(bridge as unknown as DbxBridge)
      expect(documentResources(groupConnections(snapshot.recent)).map(item => item.database)).toEqual(['shop'])
      expect([...snapshot.cacheEntries.keys()]).toEqual([JSON.stringify(['cloud', 'shop'])])
      expect(snapshot.cacheEntries.get(JSON.stringify(['cloud', 'shop']))?.state).toBe('missing')
    }
    expect(bridge.storageGet.mock.calls.some(([key]) => key === recycleKey)).toBe(false)
    expect(bridge.storageSet).not.toHaveBeenCalled()
    expect(bridge.queryData).not.toHaveBeenCalled()
    expect(bridge.getConnections).not.toHaveBeenCalled()
    expect(storage.get(recycleKey)).toBe(cached ? JSON.stringify(document()) : undefined)
  })
  it.each(['Connection is not open', 'PLUGIN_DATA_ACCESS_NOT_GRANTED'])('刷新本地列表无需数据库会话或查询权限：%s', async (message) => {
    const stored = new Map<string, string>([
      ['dbdoc.recent', JSON.stringify(recent)],
      [offlineKey({ connectionId: 'a', database: 'shop', dbType: 'mysql' }), JSON.stringify(document())]
    ])
    const bridge = {
      capabilities: { storage: true },
      storageGet: vi.fn(async (key: string) => stored.get(key) ?? null),
      storageSet: vi.fn(),
      queryData: vi.fn().mockRejectedValue(new Error(message)),
      getTableMetadata: vi.fn().mockRejectedValue(new Error(message))
    }
    const snapshot = await loadLocalDocumentList(bridge as unknown as DbxBridge)
    expect(snapshot.cacheEntries.get(JSON.stringify(['a', 'shop']))).toEqual({ state: 'ready', tableCount: 2, cachedTableCount: 2, lastSyncedAt: 200 })
    expect(snapshot.cacheEntries.get(JSON.stringify(['b', 'shop']))?.state).toBe('missing')
    const updated = document(); updated.lastSyncedAt = 500
    stored.set(offlineKey({ connectionId: 'a', database: 'shop', dbType: 'mysql' }), JSON.stringify(updated))
    stored.set('dbdoc.recent', JSON.stringify([...recent, { connectionId: 'new', database: 'new_db', name: '新连接', dbType: 'mysql', ts: 100 }]))
    const refreshed = await loadLocalDocumentList(bridge as unknown as DbxBridge)
    expect(refreshed.recent.some((entry) => entry.connectionId === 'new')).toBe(true)
    expect(refreshed.cacheEntries.get(JSON.stringify(['a', 'shop']))?.lastSyncedAt).toBe(500)
    expect(refreshed.cacheEntries.has(JSON.stringify(['new', 'new_db']))).toBe(true)
    expect(snapshot.cacheEntries.get(JSON.stringify(['a', 'shop']))?.lastSyncedAt).toBe(200)
    expect(bridge.queryData).not.toHaveBeenCalled()
    expect(bridge.getTableMetadata).not.toHaveBeenCalled()
    expect(bridge.storageSet).not.toHaveBeenCalled()
  })

  it('本地记录读取失败时报告存储错误，不尝试查询数据库', async () => {
    const queryData = vi.fn()
    const error = new Error('storage unavailable')
    const bridge = { storageGet: vi.fn().mockRejectedValue(error), queryData } as unknown as DbxBridge
    await expect(loadLocalDocumentList(bridge)).rejects.toBe(error)
    expect(queryData).not.toHaveBeenCalled()
  })

  it('distinguishes missing, complete and incomplete caches without claiming connection state', () => {
    expect(summarizeDocumentCache(null)).toEqual({ state: 'missing', tableCount: 0, cachedTableCount: 0, lastSyncedAt: null })
    const doc = document()
    const before = JSON.stringify(doc)
    expect(summarizeDocumentCache(doc)).toEqual({ state: 'ready', tableCount: 2, cachedTableCount: 2, lastSyncedAt: 200 })
    expect(JSON.stringify(doc)).toBe(before)
    delete doc.details[JSON.stringify(['b', 'orders'])]
    expect(summarizeDocumentCache(doc)).toEqual({ state: 'partial', tableCount: 2, cachedTableCount: 1, lastSyncedAt: 200 })
  })
  it('marks truncated catalogs, warnings and stale details as incomplete', () => {
    for (const reason of ['truncated', 'warning', 'stale']) {
      const doc = document()
      if (reason === 'truncated') doc.catalog.truncated = true
      if (reason === 'warning') doc.details[JSON.stringify(['a', 'orders'])].value.warnings = ['索引未能读取']
      if (reason === 'stale') doc.details[JSON.stringify(['a', 'orders'])].savedAt = 50
      expect(summarizeDocumentCache(doc).state).toBe('partial')
    }
  })
  it('does not invent successful times for legacy caches and supports synced empty databases', () => {
    const doc = document(); delete doc.lastSyncedAt
    expect(summarizeDocumentCache(doc).lastSyncedAt).toBeNull()
    doc.catalog.tables = []
    expect(summarizeDocumentCache(doc)).toEqual({ state: 'ready', tableCount: 0, cachedTableCount: 0, lastSyncedAt: null })
  })
})
