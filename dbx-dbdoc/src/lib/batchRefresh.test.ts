import { beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverBatchTargets, refreshBatch, type BatchItem, type BatchTarget, type BatchDiscoveryIssue } from './batchRefresh'
import { documentResources, groupConnections, loadLocalDocumentList } from './resources'
import { loadOffline, offlineKey } from './offline'
import { loadCatalog, loadDetail } from './store'
import type { DbxBridge, HostConnection } from './types'
import type { TableDetail } from './markdown'
import { loadRecent } from './recent'

vi.mock('./store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./store')>(),
  loadCatalog: vi.fn(), loadDetail: vi.fn()
}))

const table = { table_schema: 'public', table_name: 'orders', table_comment: 'old', engine: '', table_collation: '', column_count: 0 }
const detail: TableDetail = { table, columns: [], indexes: [], constraints: [], warnings: [] }
const target: BatchTarget = { connectionId: 'a', database: 'shop', dbType: 'mysql', name: '业务 QA' }
const key = offlineKey(target)
const oldDocument = { version: 1, savedAt: 1, lastSyncedAt: 1, catalog: { tables: [table], truncated: false },
  details: { '["public","orders"]': { savedAt: 1, value: detail } } }
function mockBridge() {
  const storage = new Map<string, string>([[key, JSON.stringify(oldDocument)]])
  let hostConnections: HostConnection[] = [
    { ...target, connected: true },
    { connectionId: 'b', name: '生产', dbType: 'postgres', database: 'shop', connected: false }
  ]
  const api = {
    capabilities: { storage: true, dataApi: true, connectionsApi: true },
    getConnections: vi.fn(async () => hostConnections),
    queryData: vi.fn(async (_request: Parameters<DbxBridge['queryData']>[0]) => ({ dbType: 'mysql', columns: [] as { name: string; dataType: string }[], rows: [[1]] as unknown[][], truncated: false })),
    storageGet: vi.fn(async (key: string) => storage.get(key) ?? null),
    storageSet: vi.fn(async (key: string, value: string) => { storage.set(key, value) })
  }
  return { api, bridge: api as unknown as DbxBridge, storage, setConnections: (value: HostConnection[]) => { hostConnections = value } }
}
const options = () => ({ shouldContinue: () => true, onUpdate: vi.fn(), onCommitted: vi.fn() })

beforeEach(() => {
  vi.mocked(loadCatalog).mockReset().mockResolvedValue({ tables: [table], truncated: false })
  vi.mocked(loadDetail).mockReset().mockResolvedValue(detail)
})

describe('批量生成离线文档', () => {
  it('枚举已连接连接下从未缓存过的数据库，去重且不混淆跨连接同名库', async () => {
    const { api, bridge, setConnections } = mockBridge()
    api.queryData.mockResolvedValue({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['new_db'], ['shop']], truncated: false } as never)
    const documents = documentResources(groupConnections([
      { ...target, database: 'shop', ts: 1 }, { ...target, database: 'reporting', ts: 2 },
      { connectionId: 'b', name: '生产', dbType: 'postgres', database: 'shop', ts: 3 }
    ]))
    const discovered = await discoverBatchTargets(bridge, documents)
    expect(discovered.map((item) => [item.connectionId, item.database])).toEqual([['a', 'reporting'], ['a', 'shop'], ['a', 'new_db']])
    expect(api.queryData).toHaveBeenCalledTimes(1)
    expect(api.queryData).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'a', sql: expect.stringContaining('INFORMATION_SCHEMA.SCHEMATA') }))
    setConnections([{ ...target, connected: true }, { ...target, connectionId: 'b', dbType: 'postgres', connected: true }])
    expect((await discoverBatchTargets(bridge, documents)).map((item) => [item.connectionId, item.database])).toEqual([
      ['a', 'reporting'], ['a', 'shop'], ['a', 'new_db'], ['b', 'shop'], ['b', 'new_db']
    ])
    expect(api.queryData).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'b', sql: expect.stringContaining('pg_database') }))
    expect(loadCatalog).not.toHaveBeenCalled()
  })

  it('无历史记录且未指定默认库时，也能从已连接会话枚举并生成新文档', async () => {
    const { api, bridge, storage, setConnections } = mockBridge()
    setConnections([{ ...target, database: undefined, connected: true }])
    api.queryData.mockResolvedValueOnce({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['brand_new']], truncated: false } as never)
    const discovered = await discoverBatchTargets(bridge, [])
    expect(discovered.map((item) => item.database)).toEqual(['brand_new'])
    expect(api.queryData.mock.calls[0][0]).not.toHaveProperty('database')
    const result = await refreshBatch(bridge, discovered, options())
    expect(result[0].state).toBe('success')
    expect(result[0].message).toContain('已生成')
    expect(storage.has(offlineKey({ ...target, database: 'brand_new' }))).toBe(true)
    expect((await loadRecent(bridge))[0].database).toBe('brand_new')
  })

  it('枚举分页直到完整，宿主忽略分页时给出目录不完整提示', async () => {
    const { api, bridge } = mockBridge()
    api.queryData.mockResolvedValueOnce({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['first']], truncated: true } as never)
      .mockResolvedValueOnce({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['second']], truncated: false } as never)
    const issues: BatchDiscoveryIssue[] = []
    expect((await discoverBatchTargets(bridge, [], { onIssue: (issue) => issues.push(issue) })).map((item) => item.database)).toEqual(['shop', 'first', 'second'])
    expect(api.queryData).toHaveBeenLastCalledWith(expect.objectContaining({ sql: expect.stringContaining('LIMIT 5000 OFFSET 1') }))
    expect(issues).toEqual([])
    api.queryData.mockResolvedValue({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['first']], truncated: true } as never)
    await discoverBatchTargets(bridge, [], { onIssue: (issue) => issues.push(issue) })
    expect(issues[0].message).toContain('未能完整读取')
  })

  it('后续目录页读取失败时保留已发现的新库并展示失败原因', async () => {
    const { api, bridge } = mockBridge()
    api.queryData.mockResolvedValueOnce({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['first_page_new']], truncated: true } as never)
      .mockRejectedValueOnce(new Error('second page unavailable'))
    const issues: BatchDiscoveryIssue[] = []
    const found = await discoverBatchTargets(bridge, [], { onIssue: (issue) => issues.push(issue) })
    expect(found.map((item) => item.database)).toEqual(['shop', 'first_page_new'])
    expect(issues[0].message).toContain('second page unavailable')
    expect(issues[0].message).toContain('未能完整读取')
  })

  it('一个连接枚举失败不阻断其他连接，明确保留失败原因与已知库', async () => {
    const { api, bridge, setConnections } = mockBridge()
    setConnections([{ ...target, connected: true }, { ...target, connectionId: 'b', database: undefined, connected: true }])
    api.queryData.mockRejectedValueOnce(new Error('PLUGIN_DATA_ACCESS_NOT_GRANTED'))
      .mockResolvedValueOnce({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['new_b']], truncated: false } as never)
    const issues: BatchDiscoveryIssue[] = []
    const found = await discoverBatchTargets(bridge, [], { onIssue: (issue) => issues.push(issue) })
    expect(found.map((item) => [item.connectionId, item.database])).toEqual([['a', 'shop'], ['b', 'new_b']])
    expect(issues).toHaveLength(1)
    expect(issues[0].connectionId).toBe('a')
    expect(issues[0].message).toContain('PLUGIN_DATA_ACCESS_NOT_GRANTED')
  })

  it('基础会话关闭时只复用已知精确会话，取消检查后不再查询下一连接', async () => {
    const { api, bridge, setConnections } = mockBridge()
    api.queryData.mockRejectedValueOnce(new Error('Connection is not open'))
      .mockResolvedValueOnce({ dbType: 'mysql', columns: [{ name: 'database_name', dataType: 'varchar' }], rows: [['new_db']], truncated: false } as never)
    expect((await discoverBatchTargets(bridge, [])).some((item) => item.database === 'new_db')).toBe(true)
    expect(api.queryData).toHaveBeenLastCalledWith(expect.objectContaining({ database: 'shop' }))
    api.queryData.mockClear()
    let active = true
    setConnections([{ ...target, connected: true }, { ...target, connectionId: 'b', connected: true }])
    await discoverBatchTargets(bridge, [], { shouldContinue: () => active, onConnection: () => { active = false } })
    expect(api.queryData).not.toHaveBeenCalled()
  })

  it('没有连接状态能力时明确提示，不猜测或探测历史连接', async () => {
    const { bridge, api } = mockBridge()
    bridge.capabilities!.connectionsApi = false
    await expect(discoverBatchTargets(bridge, [])).rejects.toThrow('升级 DBX')
    expect(api.queryData).not.toHaveBeenCalled()
  })

  it('每个库整库成功后才替换缓存并报告成功时间，不提前保存表详情', async () => {
    const { bridge, api, storage } = mockBridge()
    vi.mocked(loadDetail).mockImplementation(async () => {
      expect(storage.get(key)).toBe(JSON.stringify(oldDocument))
      return { ...detail, table: { ...table, table_comment: 'new' } }
    })
    const callbacks = options()
    const result = await refreshBatch(bridge, [target], callbacks)
    expect(result[0].state).toBe('success')
    expect(api.queryData).toHaveBeenCalledWith({ connectionId: 'a', database: 'shop', sql: 'SELECT 1', maxRows: 1 })
    const saved = await loadOffline(bridge, target)
    expect(saved?.lastSyncedAt).toBeGreaterThan(1)
    expect(saved?.details['["public","orders"]']).toBeDefined()
    expect(api.storageSet.mock.calls.filter(([name]) => name === key)).toHaveLength(1)
    expect(callbacks.onCommitted).toHaveBeenCalledWith(target)
  })

  it.each(['partial', 'truncated', 'catalog', 'storage'])('失败保留上次完整文档和成功时间：%s', async (failure) => {
    const { bridge, api, storage } = mockBridge()
    if (failure === 'partial') vi.mocked(loadDetail).mockResolvedValue({ ...detail, warnings: ['外键未能读取'] })
    if (failure === 'truncated') vi.mocked(loadCatalog).mockResolvedValue({ tables: [table], truncated: true })
    if (failure === 'catalog') vi.mocked(loadCatalog).mockRejectedValue(new Error('catalog failed'))
    if (failure === 'storage') api.storageSet.mockRejectedValue(new Error('quota exceeded'))
    const callbacks = options()
    const result = await refreshBatch(bridge, [target], callbacks)
    expect(result[0].state).toBe('failed')
    expect(result[0].message).toContain('保留原缓存')
    expect(storage.get(key)).toBe(JSON.stringify(oldDocument))
    expect(callbacks.onCommitted).not.toHaveBeenCalled()
    if (failure !== 'storage') expect(api.storageSet).not.toHaveBeenCalled()
  })

  it('跳过已断开的连接，不发出查询；具体库未打开时仅探测精确目标，不查询目录', async () => {
    const { bridge, api, storage, setConnections } = mockBridge()
    setConnections([{ ...target, connected: false }])
    expect((await refreshBatch(bridge, [target], options()))[0].state).toBe('skipped')
    expect(api.queryData).not.toHaveBeenCalled()
    setConnections([{ ...target, connected: true }])
    api.queryData.mockRejectedValueOnce(new Error('Connection is not open'))
    expect((await refreshBatch(bridge, [target], options()))[0].state).toBe('skipped')
    expect(loadCatalog).not.toHaveBeenCalled()
    expect(storage.get(key)).toBe(JSON.stringify(oldDocument))
  })

  it('单库失败继续下一个库，数据库逐个执行', async () => {
    const { bridge, api } = mockBridge()
    vi.mocked(loadCatalog).mockRejectedValueOnce(new Error('denied')).mockResolvedValue({ tables: [], truncated: false })
    const callbacks = options()
    const results = await refreshBatch(bridge, [target, { ...target, database: 'other' }], callbacks)
    expect(results.map((item) => item.state)).toEqual(['failed', 'success'])
    expect(api.queryData.mock.calls).toHaveLength(2)
    expect(callbacks.onCommitted).toHaveBeenCalledTimes(1)
  })

  it('停止时完整提交当前库，后续库不再查询或保存', async () => {
    const { bridge, api } = mockBridge()
    let stop = false
    const updates: BatchItem[] = []
    const result = await refreshBatch(bridge, [target, { ...target, database: 'other' }], {
      shouldContinue: () => !stop,
      onUpdate: (item) => { updates.push(item); if (item.state === 'running') stop = true }
    })
    expect(result.map((item) => item.state)).toEqual(['success', 'cancelled'])
    expect(api.queryData).toHaveBeenCalledTimes(1)
    expect(updates.some((item) => item.total === 1 && item.done === 1)).toBe(true)
  })

  it('生成超过八个数据库后，所有新文档入口都保留且可从本地列表找到', async () => {
    const { bridge } = mockBridge()
    vi.mocked(loadCatalog).mockResolvedValue({ tables: [], truncated: false })
    const targets = Array.from({ length: 12 }, (_, index) => ({ ...target, database: `new_${index}` }))
    const results = await refreshBatch(bridge, targets, options())
    expect(results.every((item) => item.state === 'success')).toBe(true)
    expect(await loadRecent(bridge)).toHaveLength(12)
    const snapshot = await loadLocalDocumentList(bridge)
    expect(snapshot.cacheEntries.size).toBe(12)
    expect([...snapshot.cacheEntries.values()].every((entry) => entry.state === 'ready')).toBe(true)
  })

  it('停止后不再开始任务，未同步过的数据库失败也不生成半份缓存', async () => {
    const { bridge, api, storage } = mockBridge()
    await refreshBatch(bridge, [target], { ...options(), shouldContinue: () => false })
    expect(api.queryData).not.toHaveBeenCalled()
    storage.delete(key)
    vi.mocked(loadDetail).mockRejectedValue(new Error('query failed'))
    expect((await refreshBatch(bridge, [target], options()))[0].state).toBe('failed')
    expect(storage.has(key)).toBe(false)
    expect(api.storageSet).not.toHaveBeenCalled()
  })
})
