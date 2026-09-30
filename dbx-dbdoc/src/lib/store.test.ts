import { describe, expect, it, vi } from 'vitest'
import { createSessionCache, exportSchema, listDatabases, loadCatalog, loadDetail, runConcurrentQueue, searchColumnHits } from './store'
import type { DbxBridge, QueryResult } from './types'

const result = (columns: string[], rows: unknown[][]): QueryResult => ({ dbType: 'mysql', columns: columns.map((name) => ({ name, dataType: 'varchar' })), rows, truncated: false })

// 微调说明（相对 task brief）：brief 原 fake 对含 'NULL AS expression' 的 legacy SQL 抛错、
// 普通 STATISTICS SQL 成功，导致 loadDetail 的「索引失败回退 legacy」路径永远无法触发。
// 现改为可选项 failModernIndexes：开启时普通 STATISTICS SQL（listIndexes）抛一次错、
// legacy SQL（含 NULL AS expression）成功，从而真实驱动回退重试分支；默认行为与 brief 一致。
const mkBridge = (dbType = 'mysql', opts: { failModernIndexes?: boolean; checksAvailable?: boolean } = {}): DbxBridge & { queryData: any } => ({
  ready: vi.fn(), getContext: vi.fn(), onContextChange: vi.fn(), storageGet: vi.fn(), storageSet: vi.fn(),
  saveFile: vi.fn(), copyText: vi.fn(), getTableMetadata: vi.fn(),
  queryData: vi.fn(async ({ sql }: { sql: string }) => {
    if (sql.includes('AS available')) return result(['available'], [[opts.checksAvailable === false ? 0 : 1]])
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return result(['table_schema', 'table_name', 'table_comment', 'engine', 'table_collation', 'column_count'], [['shop', 'orders', '订单', 'InnoDB', '', 2]])
    if (sql.includes('STATISTICS')) {
      if (opts.failModernIndexes && !sql.includes('NULL AS expression')) throw new Error('unknown column EXPRESSION')
      return result(['table_schema', 'table_name', 'column_name', 'seq', 'index_name', 'index_type', 'index_comment', 'non_unique', 'collation', 'sub_part', 'expression'], [['shop', 'orders', 'id', 1, 'PRIMARY', 'BTREE', '', 0, 'A', null, null]])
    }
    if (sql.includes('COLUMNS')) return result(['table_schema', 'table_name', 'column_name', 'extra', 'column_comment', 'column_type', 'data_type', 'column_default', 'column_key', 'is_nullable', 'length', 'scale', 'ordinal_position', 'character_set_name', 'collation_name', 'generation_expression'], [['shop', 'orders', 'id', null, '主键', 'bigint', 'bigint', null, 'PRI', 'NO', null, null, 1, null, null, null]])
    if (sql.includes('KEY_COLUMN_USAGE')) return result(['table_schema', 'table_name', 'constraint_name', 'column_name', 'seq', 'referenced_schema', 'referenced_table', 'referenced_column', 'update_rule', 'delete_rule'], [])
    if (sql.includes('CHECK')) return result(['table_schema', 'table_name', 'constraint_name', 'check_clause'], [])
    if (sql.includes('SCHEMATA')) return result(['database_name'], [['shop'], ['other']])
    return result(['table_schema', 'table_name'], [])
  })
} as any)

const adapter = (await import('./dialects/registry')).getAdapter('mysql')!
const ref = { db: 'shop', schema: null, table: null }

describe('loaders', () => {
  it('MySQL 5.7 缺失检查约束系统表时不查询它，并发切表只检测一次', async () => {
    const bridge = mkBridge('mysql', { checksAvailable: false, failModernIndexes: true })
    const details = await Promise.all(['orders', 'users'].map((table) => loadDetail(bridge, adapter, 'c1', ref, 'shop', table)))
    for (const detail of details) {
      expect(detail.columns).toHaveLength(1)
      expect(detail.indexes).toHaveLength(1)
      expect(detail.checksSupported).toBe(false)
      expect(detail.warnings).toEqual([])
    }
    const sqls = bridge.queryData.mock.calls.map(([request]: any[]) => request.sql as string)
    expect(sqls.filter((sql: string) => sql.includes('AS available'))).toHaveLength(1)
    expect(sqls.some((sql: string) => sql.includes('JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS'))).toBe(false)
  })
  it('支持检查约束的版本继续读取和展示 CHECK 内容', async () => {
    const bridge = mkBridge()
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (request: { sql: string }) => request.sql.includes('JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS')
      ? result(['table_schema', 'table_name', 'constraint_name', 'check_clause'], [['shop', 'orders', 'amount_check', 'amount > 0']]) : base(request))
    const detail = await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')
    expect(detail.checksSupported).toBe(true)
    expect(detail.constraints).toEqual([expect.objectContaining({ constraint_type: 'CHECK', check_clause: 'amount > 0' })])
    expect(detail.warnings).toEqual([])
  })
  it('同一工作台中连接和数据库的检测结果不相互污染', async () => {
    const bridge = mkBridge()
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (request: { sql: string; connectionId: string; database: string }) => {
      if (request.sql.includes('AS available')) return result(['available'], [[request.connectionId === 'legacy' && request.database === 'shop' ? 0 : 1]])
      return base(request)
    })
    expect((await loadDetail(bridge, adapter, 'legacy', ref, 'shop', 'orders')).checksSupported).toBe(false)
    expect((await loadDetail(bridge, adapter, 'modern', ref, 'shop', 'orders')).checksSupported).toBe(true)
    expect((await loadDetail(bridge, adapter, 'legacy', { ...ref, db: 'other' }, 'other', 'orders')).checksSupported).toBe(true)
  })
  it('CHECK 查询的权限或服务器错误仍然提示，不作为版本不支持处理', async () => {
    const bridge = mkBridge()
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (request: { sql: string }) => {
      if (request.sql.includes('JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS')) throw new Error('SELECT command denied')
      return base(request)
    })
    const detail = await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')
    expect(detail.checksSupported).toBe(true)
    expect(detail.warnings).toContain('检查约束未能读取：SELECT command denied')
  })
  it('检测失败不缓存成不支持，恢复后能够重新检测', async () => {
    const bridge = mkBridge('mysql', { checksAvailable: false })
    const base = bridge.queryData.getMockImplementation()!
    let failing = true
    bridge.queryData.mockImplementation(async (request: { sql: string }) => {
      if (failing && request.sql.includes('AS available')) throw new Error('连接中断')
      return base(request)
    })
    const first = await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')
    expect(first.checksSupported).toBeUndefined()
    expect(first.warnings).toContain('检查约束未能读取：连接中断')
    failing = false
    const second = await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')
    expect(second.checksSupported).toBe(false)
    expect(second.warnings).toEqual([])
  })
  it('能力检测授权被拒仍上抛，恢复授权后不复用拒绝结果', async () => {
    const bridge = mkBridge('mysql', { checksAvailable: false })
    const base = bridge.queryData.getMockImplementation()!
    let denied = true
    bridge.queryData.mockImplementation(async (request: { sql: string }) => {
      if (denied && request.sql.includes('AS available')) throw new Error('PLUGIN_DATA_ACCESS_NOT_GRANTED')
      return base(request)
    })
    await expect(loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')).rejects.toThrow('PLUGIN_DATA_ACCESS_NOT_GRANTED')
    denied = false
    expect((await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')).checksSupported).toBe(false)
  })
  it('可选元数据读取失败或截断时保留字段并附上提示', async () => {
    const bridge = mkBridge()
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (req: { sql: string }) => {
      if (req.sql.includes('CHECK')) throw new Error('版本不支持 CHECK')
      const response = await base(req)
      if (req.sql.includes('STATISTICS')) response.truncated = true
      return response
    })
    const detail = await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')
    expect(detail.columns).toHaveLength(1)
    expect(detail.warnings).toEqual(expect.arrayContaining(['索引列表被宿主截断', '检查约束未能读取：版本不支持 CHECK']))
  })
  it('loadCatalog 映射表清单', async () => {
    const bridge = mkBridge()
    const { tables } = await loadCatalog(bridge, adapter, 'c1', ref)
    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatchObject({ table_schema: 'shop', table_name: 'orders', table_comment: '订单', column_count: 2 })
    expect(bridge.queryData).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1', maxRows: 5000 }))
  })
  it('loadDetail 索引失败自动回退 legacy SQL', async () => {
    const bridge = mkBridge('mysql', { failModernIndexes: true })
    const detail = await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders')
    expect(detail.columns[0].column_name).toBe('id')
    expect(detail.indexes[0].is_primary).toBe(true)
    expect(bridge.queryData).toHaveBeenCalled()
    const sqls: string[] = bridge.queryData.mock.calls.map((call: any[]) => call[0].sql)
    expect(sqls.some((sql) => sql.includes('NULL AS expression'))).toBe(true)
  })
  it('searchColumnHits 返回 schema.table 集合并通知查询截断', async () => {
    const bridge = mkBridge()
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (request: { sql: string }) => ({ ...await base(request), truncated: true }))
    const onTruncated = vi.fn()
    const hits = await searchColumnHits(bridge, adapter, 'c1', ref, 'id', onTruncated)
    expect([...hits]).toEqual(['shop.orders'])
    expect(onTruncated).toHaveBeenCalledOnce()
  })
  it('loadDetail 以 schema 形参过滤详情查询（pg 同名表不跨 schema 合并）', async () => {
    const bridge = mkBridge('postgres')
    const sqls: string[] = []
    bridge.queryData.mockImplementation(async ({ sql }: { sql: string }) => {
      sqls.push(sql)
      return result([], [])
    })
    const pgAdapter = (await import('./dialects/registry')).getAdapter('postgres')!
    await loadDetail(bridge, pgAdapter, 'c1', { db: 'app', schema: null, table: null }, 'public', 'orders')
    // 四条详情查询（columns/indexes/FK/checks）都应携带目标 schema 的等值过滤
    const columnSql = sqls.find((sql) => sql.includes('information_schema.columns AS c'))
    expect(columnSql).toBeDefined()
    expect(columnSql).toContain("c.table_schema = 'public'")
    expect(columnSql).toContain("c.table_name = 'orders'")
  })
  it('exportSchema 并发拉取并回调进度，可取消', async () => {
    const bridge = mkBridge()
    const tables = [{ table_schema: 'shop', table_name: 'orders', table_comment: '订单', engine: 'InnoDB', table_collation: '', column_count: 1 }] as any[]
    const onProgress = vi.fn()
    const { details, failed } = await exportSchema(bridge, adapter, 'c1', ref, tables, { concurrency: 2, onProgress, shouldContinue: () => (onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0] ?? 0) < 1 })
    expect(onProgress).toHaveBeenCalled()
    expect(details.length).toBeLessThanOrEqual(1)
    expect(failed).toEqual([])
    // catalog 行的表注释/引擎元数据合并进 detail.table（loadDetail 查询不含这些字段）
    expect(details[0]?.table.table_comment).toBe('订单')
    expect(details[0]?.table.engine).toBe('InnoDB')
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })
  it('exportSchema 两表其一失败：details 缺它、failed 含其名，其余表照常导出', async () => {
    const bridge = mkBridge()
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (req: { sql: string }) => {
      if (req.sql.includes("TABLE_NAME = 'ghost'")) throw new Error('ghost 表不存在')
      return base(req)
    })
    const mkTable = (name: string) => ({ table_schema: 'shop', table_name: name, table_comment: '', engine: '', table_collation: '', column_count: 1 }) as any
    const { details, failed } = await exportSchema(bridge, adapter, 'c1', ref, [mkTable('orders'), mkTable('ghost')], { concurrency: 2, onProgress: () => undefined, shouldContinue: () => true })
    expect(details.map((d) => d.table.table_name)).toEqual(['orders'])
    expect(failed).toEqual([{ schema: 'shop', table: 'ghost', message: 'ghost 表不存在' }])
  })

  it.each(['Connection is not open', 'Database session is not open', 'PLUGIN_DATA_ACCESS_NOT_GRANTED: denied'])('会话不可用时停止导出入队，未开始的表可在恢复后补全：%s', async (message) => {
    const bridge = mkBridge()
    bridge.queryData.mockRejectedValue(new Error(message))
    const tables = ['orders', 'later', 'last'].map((table_name) => ({ table_schema: 'shop', table_name, table_comment: '', engine: '', table_collation: '', column_count: 1 }))
    const onProgress = vi.fn()
    const outcome = await exportSchema(bridge, adapter, 'c1', ref, tables, { concurrency: 1, onProgress, shouldContinue: () => true })
    expect(outcome.details).toEqual([])
    expect(outcome.failed).toEqual([{ schema: 'shop', table: 'orders', message }])
    const sqls = bridge.queryData.mock.calls.map(([request]: any[]) => request.sql as string)
    expect(sqls.some((sql: string) => sql.includes("TABLE_NAME = 'later'") || sql.includes("TABLE_NAME = 'last'"))).toBe(false)
    expect(onProgress).toHaveBeenLastCalledWith(1, 3)
  })
})

describe('createSessionCache', () => {
  it('详情缓存有总容量限制，读取更新 LRU，分隔符不造成键冲突', () => {
    const cache = createSessionCache(2)
    const detail: any = { table: {}, columns: [], indexes: [], constraints: [] }
    cache.setDetail('c1', 'public', 'a', detail)
    cache.setDetail('c1', 'public', 'b', detail)
    cache.detail('c1', 'public', 'a')
    cache.setDetail('c2', 'public', 'c', detail)
    expect(cache.detail('c1', 'public', 'a')).toBe(detail)
    expect(cache.detail('c1', 'public', 'b')).toBeUndefined()
  })
  it('刷新期间的旧详情响应不重新填充已失效的缓存', async () => {
    const cache = createSessionCache()
    const bridge = mkBridge()
    let resolve!: (result: QueryResult) => void
    const base = bridge.queryData.getMockImplementation()!
    bridge.queryData.mockImplementation(async (req: { sql: string }) => {
      if (req.sql.includes('COLUMNS')) return new Promise<QueryResult>((r) => { resolve = r })
      return base(req)
    })
    const { connKeyOf } = await import('./store')
    const pending = loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders', cache)
    cache.clear(connKeyOf('c1', ref))
    resolve(result([], []))
    await pending
    expect(cache.detail(connKeyOf('c1', ref), 'shop', 'orders')).toBeUndefined()
  })
  it('缓存 catalog/detail 并按 connKey 清理', () => {
    const cache = createSessionCache()
    const tables = [{ table_schema: 'shop', table_name: 'orders', table_comment: '', engine: '', table_collation: '', column_count: 1 }]
    cache.setCatalog('k1', { tables: tables as any, truncated: false })
    expect(cache.catalog('k1')).toEqual({ tables, truncated: false })
    const detail = { table: tables[0], columns: [], indexes: [], constraints: [] }
    cache.setDetail('k1', 'shop', 'orders', detail as any)
    expect(cache.detail('k1', 'shop', 'orders')).toBe(detail)
    cache.clear('k1')
    expect(cache.catalog('k1')).toBeUndefined()
    expect(cache.detail('k1', 'shop', 'orders')).toBeUndefined()
  })
  it('loadCatalog/loadDetail 命中缓存不再发查询', async () => {
    const bridge = mkBridge()
    const cache = createSessionCache()
    await loadCatalog(bridge, adapter, 'c1', ref, cache)
    await loadCatalog(bridge, adapter, 'c1', ref, cache)
    expect(bridge.queryData).toHaveBeenCalledTimes(1)
    await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders', cache)
    await loadDetail(bridge, adapter, 'c1', ref, 'shop', 'orders', cache)
    // 1（catalog）+ 4（columns/indexes/FK/checks）+ 1（首次能力检测），第二次命中缓存。
    expect(bridge.queryData).toHaveBeenCalledTimes(6)
  })
})

describe('runConcurrentQueue', () => {
  it('全部完成且异常不中断队列', async () => {
    const settled: string[] = []
    await runConcurrentQueue(['a', 'b', 'c'], async (item) => {
      if (item === 'b') throw new Error('boom')
    }, { concurrency: 2, onSettled: (r) => settled.push(`${r.item}:${r.status}`) })
    expect(settled.sort()).toEqual(['a:fulfilled', 'b:rejected', 'c:fulfilled'])
  })
  it('shouldContinue 为 false 时停止派发新任务', async () => {
    let started = 0
    const settled: number[] = []
    await runConcurrentQueue([1, 2, 3, 4], async (item) => {
      started += 1
      await Promise.resolve()
      if (item === 1) return
    }, { concurrency: 1, shouldContinue: () => started < 2, onSettled: (r) => settled.push(r.index) })
    expect(started).toBeLessThanOrEqual(2)
    expect(settled).toEqual([0, 1])
  })
  it('空队列直接返回', async () => {
    const onSettled = vi.fn()
    await runConcurrentQueue([], async () => {}, { onSettled })
    expect(onSettled).not.toHaveBeenCalled()
  })
})

describe('listDatabases', () => {
  it('mysql 返回枚举的库名', async () => {
    const bridge = mkBridge()
    const dbs = await listDatabases(bridge, adapter, 'c1', ref)
    expect(dbs).toEqual(['shop', 'other'])
    expect(bridge.queryData).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('SCHEMATA') }))
  })
  it('方言未实现（postgres）返回空列表', async () => {
    const bridge = mkBridge()
    const pgAdapter = (await import('./dialects/registry')).getAdapter('postgres')!
    expect(await listDatabases(bridge, pgAdapter, 'c1', ref)).toEqual([])
    expect(bridge.queryData).not.toHaveBeenCalled()
  })
  it('查询失败按空列表处理（不中断引导流程）', async () => {
    const bridge = mkBridge()
    ;(bridge.queryData as any) = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(await listDatabases(bridge, adapter, 'c1', ref)).toEqual([])
  })
  it('选择器严格模式保留读取错误，供页面显示原因和重试', async () => {
    const bridge = mkBridge()
    bridge.queryData = vi.fn().mockRejectedValue(new Error('session unavailable'))
    await expect(listDatabases(bridge, adapter, 'c1', ref, true)).rejects.toThrow('session unavailable')
  })
  it('授权拒绝始终传递，不被误认为空数据库列表', async () => {
    const bridge = mkBridge()
    bridge.queryData = vi.fn().mockRejectedValue(new Error('PLUGIN_DATA_ACCESS_NOT_GRANTED'))
    await expect(listDatabases(bridge, adapter, 'c1', ref)).rejects.toThrow('PLUGIN_DATA_ACCESS_NOT_GRANTED')
  })
})
