import { describe, expect, it, vi } from 'vitest'
import { cacheAllTables, finishOfflineSync, exportOfflineSchema, searchOfflineColumnMatches, loadOffline, offlineKey, offlineTableKey, saveOffline, withOfflineDetail, type OfflineDocument } from './offline'
import type { DbxBridge } from './types'
import type { TableDetail } from './markdown'

const ctx = { connectionId: 'c1', database: 'shop', dbType: 'mysql' }
const detail = (schema = 'shop', name = 'orders'): TableDetail => ({
  table: { table_schema: schema, table_name: name, table_comment: '订单', engine: '', table_collation: '', column_count: 0 },
  columns: [], indexes: [], constraints: []
})
const document = (): OfflineDocument => ({ version: 1, savedAt: 123, catalog: { tables: [detail().table], truncated: false }, details: {} })
const host = (storage = new Map<string, string>()) => ({
  capabilities: { storage: true },
  storageGet: vi.fn(async (key: string) => storage.get(key) ?? null),
  storageSet: vi.fn(async (key: string, value: string) => { storage.set(key, value) })
}) as unknown as DbxBridge

describe('offline documents', () => {
  it('restores metadata through a new host session and isolates connection, database and dialect', async () => {
    const storage = new Map<string, string>()
    const doc = withOfflineDetail(document(), detail())
    expect(await saveOffline(host(storage), ctx, doc)).toBe(true)
    const reopened = host(storage)
    expect(await loadOffline(reopened, ctx)).toEqual(doc)
    for (const other of [{ ...ctx, connectionId: 'c2' }, { ...ctx, database: 'other' }, { ...ctx, dbType: 'postgres' }]) {
      expect(await loadOffline(reopened, other)).toBeNull()
    }
  })
  it('keeps every table beyond 128, including cross-schema names', () => {
    let doc = withOfflineDetail(withOfflineDetail(document(), detail('a')), detail('b'))
    expect(Object.keys(doc.details)).toHaveLength(2)
    for (let i = 0; i < 128; i++) doc = withOfflineDetail(doc, detail('a', `t${i}`))
    expect(Object.keys(doc.details)).toHaveLength(130)
    expect(doc.details[offlineTableKey('a', 'orders')]).toBeDefined()
    expect(doc.details[offlineTableKey('a', 't127')].value.table.table_name).toBe('t127')
  })
  it('tolerates corrupt snapshots, failed reads, and malformed detail entries', async () => {
    const storage = new Map([[offlineKey(ctx), '{bad']])
    const bridge = host(storage)
    expect(await loadOffline(bridge, ctx)).toBeNull()
    storage.set(offlineKey(ctx), JSON.stringify({ ...document(), details: { bad: { value: {} } } }))
    expect((await loadOffline(bridge, ctx))?.details).toEqual({})
    vi.mocked(bridge.storageGet).mockRejectedValue(new Error('unavailable'))
    expect(await loadOffline(bridge, ctx)).toBeNull()
  })
  it('serializes saves and recovers after a storage failure', async () => {
    const bridge = host()
    vi.mocked(bridge.storageSet).mockRejectedValueOnce(new Error('full'))
    const newer = { ...document(), savedAt: 456 }
    expect(await Promise.all([saveOffline(bridge, ctx, document()), saveOffline(bridge, ctx, newer)])).toEqual([false, true])
    expect(await loadOffline(bridge, ctx)).toEqual(newer)
  })
  it('reports unavailable persistent storage', async () => {
    const bridge = host()
    bridge.capabilities!.storage = false
    expect(await saveOffline(bridge, ctx, document())).toBe(false)
    expect(bridge.storageSet).not.toHaveBeenCalled()
  })
})

describe('whole database offline sync', () => {
  it('loads every table without requiring visits and preserves schema identity', async () => {
    const tables = Array.from({ length: 140 }, (_, i) => detail(i % 2 ? 'a' : 'b', `table${i}`).table)
    const load = vi.fn(async (table) => detail(table.table_schema, table.table_name))
    let doc = document()
    const progress = vi.fn()
    await cacheAllTables(tables, load, { shouldContinue: () => true, onDetail: (value) => { doc = withOfflineDetail(doc, value) }, onProgress: progress })
    expect(load).toHaveBeenCalledTimes(140)
    expect(Object.keys(doc.details)).toHaveLength(140)
    expect(progress).toHaveBeenLastCalledWith(140, 0)
    const bridge = host()
    await saveOffline(bridge, ctx, doc)
    expect(Object.keys((await loadOffline(bridge, ctx))!.details)).toHaveLength(140)
  })
  it('retains successful tables and reports failures and incomplete metadata', async () => {
    const tables = ['good', 'failed', 'partial'].map((name) => detail('a', name).table)
    const progress = vi.fn()
    const saved: string[] = []
    await cacheAllTables(tables, async (table) => {
      if (table.table_name === 'failed') throw new Error('query failed')
      return { ...detail('a', table.table_name), warnings: table.table_name === 'partial' ? ['索引未能读取'] : [] }
    }, { shouldContinue: () => true, onDetail: (value) => { saved.push(value.table.table_name) }, onProgress: progress })
    expect(saved.sort()).toEqual(['good', 'partial'])
    expect(progress).toHaveBeenLastCalledWith(3, 2)
  })
  it('stops dispatching on disconnect and ignores responses after a context change', async () => {
    const tables = Array.from({ length: 10 }, (_, i) => detail('a', `t${i}`).table)
    const load = vi.fn(async () => { throw new Error('Connection is not open') })
    const onDetail = vi.fn()
    await cacheAllTables(tables, load, { shouldContinue: () => true, onDetail, onProgress: vi.fn() })
    expect(load.mock.calls.length).toBeLessThanOrEqual(2)
    let active = true
    await cacheAllTables(tables, async () => { active = false; return detail() }, { shouldContinue: () => active, onDetail, onProgress: vi.fn() })
    expect(onDetail).not.toHaveBeenCalled()
  })
})

describe('host storage limits', () => {
  it('compresses a full 80-table document below the host per-value cap and restores all tables', async () => {
    let doc = document()
    for (let i = 0; i < 80; i++) {
      const value = detail('public', `table${i}`)
      value.columns = Array.from({ length: 60 }, (_, j) => ({
        table_schema: 'public', table_name: `table${i}`, column_name: `column${j}`,
        column_comment: '字段注释：用于描述业务信息与离线文档', column_type: 'varchar(255)',
        data_type: 'varchar', is_nullable: 'YES', column_default: null, ordinal_position: j + 1
      })) as TableDetail['columns']
      doc = withOfflineDetail(doc, value)
    }
    doc.catalog.tables = Object.values(doc.details).map((entry) => entry.value.table)
    expect(new TextEncoder().encode(JSON.stringify(doc)).length).toBeGreaterThan(256 * 1024)
    const storage = new Map<string, string>()
    const bridge = host(storage)
    vi.mocked(bridge.storageSet).mockImplementation(async (key, value) => {
      if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) throw new Error('plugin UI storage value exceeds 262144 bytes')
      storage.set(key, value)
    })
    expect(await saveOffline(bridge, ctx, doc)).toBe(true)
    expect(JSON.parse(storage.get(offlineKey(ctx))!).encoding).toBe('gzip-base64')
    expect(await loadOffline(host(storage), ctx)).toEqual(doc)
  })
  it('reads legacy uncompressed snapshots and reports the actual storage failure', async () => {
    const bridge = host(new Map([[offlineKey(ctx), JSON.stringify(document())]]))
    expect(await loadOffline(bridge, ctx)).toEqual(document())
    vi.mocked(bridge.storageSet).mockRejectedValue(new Error('plugin UI storage exceeds 1048576 bytes'))
    const onError = vi.fn()
    expect(await saveOffline(bridge, ctx, document(), onError)).toBe(false)
    expect(onError).toHaveBeenCalledWith('plugin UI storage exceeds 1048576 bytes')
  })
})

describe('offline field search', () => {
  const fixture = () => {
    let doc = document()
    for (const [schema, name, comment] of [
      ['public', 'user_id', '下单用户编号'], ['sales', 'User_ID', '销售用户标识'], ['public', 'price_%', '含税金额.*']
    ]) {
      const value = detail(schema, name === 'price_%' ? 'payments' : 'orders')
      value.columns = [{ column_name: name, column_comment: comment }] as TableDetail['columns']
      doc = withOfflineDetail(doc, value)
    }
    doc.catalog.tables = Object.values(doc.details).map((entry) => entry.value.table)
    return doc
  }
  it('matches field names case-insensitively and keeps cross-schema tables separate', () => {
    const hits = searchOfflineColumnMatches(fixture(), ' USER_id ')
    expect([...hits.keys()]).toEqual([offlineTableKey('public', 'orders'), offlineTableKey('sales', 'orders')])
    expect(hits.get(offlineTableKey('sales', 'orders'))).toEqual([{ name: 'User_ID', comment: '销售用户标识' }])
  })
  it('matches Chinese field comments, respects Schema selection, and treats special characters literally', () => {
    const doc = fixture()
    expect([...searchOfflineColumnMatches(doc, '用户', 'public').keys()]).toEqual([offlineTableKey('public', 'orders')])
    expect(searchOfflineColumnMatches(doc, '下单', 'sales').size).toBe(0)
    expect([...searchOfflineColumnMatches(doc, '%').keys()]).toEqual([offlineTableKey('public', 'payments')])
    expect([...searchOfflineColumnMatches(doc, '.*').keys()]).toEqual([offlineTableKey('public', 'payments')])
  })
  it('searches restored compressed documents and skips missing or out-of-catalog details', async () => {
    const bridge = host()
    const doc = fixture()
    const missing = detail('public', 'uncached').table
    doc.catalog.tables.push(missing)
    doc.catalog.tables = doc.catalog.tables.filter((table) => table.table_schema !== 'sales')
    await saveOffline(bridge, ctx, doc)
    const restored = await loadOffline(bridge, ctx)
    expect(searchOfflineColumnMatches(restored, '用户').size).toBe(1)
    expect(searchOfflineColumnMatches(restored, 'missing').size).toBe(0)
    expect(searchOfflineColumnMatches(restored, '  ').size).toBe(0)
    expect(searchOfflineColumnMatches(null, '用户').size).toBe(0)
    expect(bridge.storageGet).toHaveBeenCalledTimes(1)
  })
})

describe('offline database export', () => {
  it('exports every scoped cached table in catalog order and preserves metadata without host calls', async () => {
    let doc = document()
    const first = detail('public', 'orders')
    first.warnings = ['外键上次读取失败，缓存信息不完整']
    first.columns = [{ column_name: 'user_id', column_comment: '下单用户' }] as TableDetail['columns']
    first.indexes = [{ index_name: 'idx_user_id' }] as TableDetail['indexes']
    first.constraints = [{ constraint_name: 'fk_user' }] as TableDetail['constraints']
    doc = withOfflineDetail(withOfflineDetail(doc, first), detail('sales', 'orders'))
    const tables = [detail('sales', 'orders').table, { ...first.table, table_comment: '目录最新注释' }, detail('public', 'missing').table]
    doc.catalog.tables = tables
    const bridge = host()
    await saveOffline(bridge, ctx, doc)
    const restored = await loadOffline(bridge, ctx)
    vi.mocked(bridge.storageGet).mockClear()
    vi.mocked(bridge.storageSet).mockClear()
    const exported = exportOfflineSchema(restored, tables)
    expect(exported.details.map((value) => value.table.table_schema)).toEqual(['sales', 'public'])
    expect(exported.details[1].table.table_comment).toBe('目录最新注释')
    expect(exported.details[1].columns).toEqual(first.columns)
    expect(exported.details[1].indexes).toEqual(first.indexes)
    expect(exported.details[1].constraints).toEqual(first.constraints)
    expect(exported.details[1].warnings).toEqual(first.warnings)
    expect(exported.failed).toEqual([{ schema: 'public', table: 'missing', message: '本地缓存缺失，未包含在导出文档中' }])
    expect(bridge.storageGet).not.toHaveBeenCalled()
    expect(bridge.storageSet).not.toHaveBeenCalled()
    expect(exportOfflineSchema(restored, tables.filter((table) => table.table_schema === 'sales')).details).toHaveLength(1)
  })
  it('reports every requested missing table instead of querying or fabricating empty structures', () => {
    const tables = [detail('public', 'orders').table, detail('sales', 'orders').table]
    expect(exportOfflineSchema(null, tables)).toEqual({ details: [], failed: tables.map((table) => ({ schema: table.table_schema, table: table.table_name, message: '本地缓存缺失，未包含在导出文档中' })) })
    expect(exportOfflineSchema(document(), [])).toEqual({ details: [], failed: [] })
  })
})

describe('last successful whole-database sync time', () => {
  const snapshot = (): OfflineDocument => {
    const doc = withOfflineDetail(document(), detail())
    doc.lastSyncedAt = 100
    doc.details[offlineTableKey('shop', 'orders')].savedAt = 200
    return doc
  }
  it('advances only after all metadata is complete and the final snapshot is persisted', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5000)
    try {
      const doc = snapshot()
      let release!: (saved: boolean) => void
      const persist = vi.fn((_document: OfflineDocument) => new Promise<boolean>((resolve) => { release = resolve }))
      const pending = finishOfflineSync(doc, 1, 0, persist)
      expect(doc.lastSyncedAt).toBe(100)
      expect(persist.mock.calls[0][0].lastSyncedAt).toBe(5000)
      release(true)
      expect((await pending).lastSyncedAt).toBe(5000)
      expect(doc.lastSyncedAt).toBe(100)
    } finally { now.mockRestore() }
  })
  it('preserves the previous successful time on partial, failed, stale, or truncated refreshes', async () => {
    const incomplete = snapshot(); delete incomplete.details[offlineTableKey('shop', 'orders')]
    const warning = snapshot(); warning.details[offlineTableKey('shop', 'orders')].value.warnings = ['索引未能读取']
    const stale = snapshot(); stale.details[offlineTableKey('shop', 'orders')].savedAt = 1
    const truncated = snapshot(); truncated.catalog.truncated = true
    for (const [doc, done, failed] of [[snapshot(), 0, 0], [snapshot(), 1, 1], [incomplete, 1, 0], [warning, 1, 0], [stale, 1, 0], [truncated, 1, 0]] as [OfflineDocument, number, number][]) {
      const persist = vi.fn(async () => true)
      const result = await finishOfflineSync(doc, done, failed, persist)
      expect(result).toBe(doc)
      expect(result.lastSyncedAt).toBe(100)
      expect(persist).not.toHaveBeenCalled()
    }
  })
  it('keeps the prior persisted time if final storage fails, then advances after a successful retry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5000)
    try {
      const bridge = host()
      const doc = snapshot()
      await saveOffline(bridge, ctx, doc)
      vi.mocked(bridge.storageSet).mockRejectedValueOnce(new Error('storage full'))
      const failed = await finishOfflineSync(doc, 1, 0, (value) => saveOffline(bridge, ctx, value))
      expect(failed.lastSyncedAt).toBe(100)
      expect((await loadOffline(bridge, ctx))?.lastSyncedAt).toBe(100)
      const success = await finishOfflineSync(failed, 1, 0, (value) => saveOffline(bridge, ctx, value))
      expect(success.lastSyncedAt).toBe(5000)
      expect((await loadOffline(bridge, ctx))?.lastSyncedAt).toBe(5000)
    } finally { now.mockRestore() }
  })
  it('does not invent a success time for legacy caches or invalid timestamps', async () => {
    const bridge = host(new Map([[offlineKey(ctx), JSON.stringify(document())]]))
    expect((await loadOffline(bridge, ctx))?.lastSyncedAt).toBeUndefined()
    for (const lastSyncedAt of [-1, 'yesterday', null]) {
      vi.mocked(bridge.storageGet).mockResolvedValueOnce(JSON.stringify({ ...document(), lastSyncedAt }))
      expect((await loadOffline(bridge, ctx))?.lastSyncedAt).toBeUndefined()
    }
    expect((await finishOfflineSync(document(), 0, 1, async () => true)).lastSyncedAt).toBeUndefined()
  })
  it('records a successfully synced empty database', async () => {
    const doc = document(); doc.catalog.tables = []
    expect((await finishOfflineSync(doc, 0, 0, async () => true)).lastSyncedAt).toBeTypeOf('number')
  })
})

describe('atomic replacement of the full offline document', () => {
  function complete(name: string, comment: string) {
    const row = detail('public', name)
    row.table.table_comment = comment
    row.columns = [{ column_name: name + '_id', column_comment: comment }] as TableDetail['columns']
    const doc = withOfflineDetail({ ...document(), savedAt: 100, catalog: { tables: [row.table], truncated: false } }, row)
    doc.details[offlineTableKey('public', name)].savedAt = 200
    doc.lastSyncedAt = 50
    return doc
  }
  it('keeps the full previous catalog, fields, and timestamp unchanged on partial failure, including after reopen', async () => {
    const bridge = host()
    const previous = complete('old_table', '原始完整缓存')
    const staged = complete('new_table', '尚未成功的新数据')
    staged.catalog.tables.push(detail('public', 'failed_table').table)
    await saveOffline(bridge, ctx, previous)
    const before = JSON.stringify(previous)
    vi.mocked(bridge.storageSet).mockClear()
    const result = await finishOfflineSync(staged, 2, 1, (value) => saveOffline(bridge, ctx, value), previous)
    expect(result).toBe(previous)
    expect(JSON.stringify(previous)).toBe(before)
    expect(await loadOffline(bridge, ctx)).toEqual(previous)
    expect(bridge.storageSet).not.toHaveBeenCalled()
    expect(searchOfflineColumnMatches(result, '原始').size).toBe(1)
    expect(exportOfflineSchema(result, previous.catalog.tables).details[0].table.table_name).toBe('old_table')
  })
  it('replaces catalog and all details together only after one successful save', async () => {
    const bridge = host()
    const previous = complete('old_table', '旧数据')
    const staged = complete('new_table', '新数据')
    await saveOffline(bridge, ctx, previous)
    let allowSave!: () => void
    const persist = vi.fn(async (value: OfflineDocument) => {
      await new Promise<void>((resolve) => { allowSave = resolve })
      return saveOffline(bridge, ctx, value)
    })
    const pending = finishOfflineSync(staged, 1, 0, persist, previous)
    expect(await loadOffline(bridge, ctx)).toEqual(previous)
    expect(previous.catalog.tables[0].table_name).toBe('old_table')
    allowSave()
    const committed = await pending
    expect(committed?.catalog.tables[0].table_name).toBe('new_table')
    expect(committed?.details[offlineTableKey('public', 'old_table')]).toBeUndefined()
    expect(await loadOffline(bridge, ctx)).toEqual(committed)
    expect(persist).toHaveBeenCalledTimes(1)
  })
  it('preserves the previous full document on storage failure or cancellation', async () => {
    const bridge = host()
    const previous = complete('old_table', '旧数据')
    const staged = complete('new_table', '新数据')
    await saveOffline(bridge, ctx, previous)
    vi.mocked(bridge.storageSet).mockRejectedValueOnce(new Error('storage full'))
    expect(await finishOfflineSync(staged, 1, 0, (value) => saveOffline(bridge, ctx, value), previous)).toBe(previous)
    expect(await loadOffline(bridge, ctx)).toEqual(previous)
    const persist = vi.fn(async () => true)
    expect(await finishOfflineSync(staged, 1, 0, persist, previous, () => false)).toBe(previous)
    expect(persist).not.toHaveBeenCalled()
  })
  it('leaves no cached document when the first synchronization fails', async () => {
    const bridge = host()
    const staged = complete('new_table', '部分数据')
    const persist = vi.fn((value: OfflineDocument) => saveOffline(bridge, ctx, value))
    expect(await finishOfflineSync(staged, 1, 1, persist, null)).toBeNull()
    expect(await loadOffline(bridge, ctx)).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })
})
