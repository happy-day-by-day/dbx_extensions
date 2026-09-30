import { describe, expect, it, vi } from 'vitest'
import { contextWithRecent, loadRecent, mergeRecent, parseRecent, recentKeyOf, rememberConnection, type RecentConnection } from './recent'
import type { DbxBridge } from './types'

const entry = (connectionId: string, database: string | null, ts = 1): RecentConnection => ({
  connectionId,
  name: connectionId + '-name',
  dbType: 'mysql',
  database,
  ts
})

const mkBridge = (store = new Map<string, string>()): DbxBridge & { storageSet: any } =>
  ({
    ready: vi.fn(),
    getContext: vi.fn(),
    onContextChange: vi.fn(),
    queryData: vi.fn(),
    getTableMetadata: vi.fn(),
    storageGet: vi.fn(async (key: string) => store.get(key) ?? null),
    storageSet: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    saveFile: vi.fn(),
    copyText: vi.fn()
  }) as any

describe('recent', () => {
  it('recentKeyOf 以 连接+库 为键', () => {
    expect(recentKeyOf({ connectionId: 'c1', database: 'shop' })).toBe('c1::shop')
    expect(recentKeyOf({ connectionId: 'c1', database: null })).toBe('c1::')
    expect(recentKeyOf({ connectionId: 'c1', database: 'shop' })).not.toBe(recentKeyOf({ connectionId: 'c2', database: 'shop' }))
  })

  it('mergeRecent 同键置顶覆盖、异键保留、容量截断', () => {
    const base = [entry('c1', 'a', 1), entry('c1', 'b', 2), entry('c2', 'a', 3)]
    const merged = mergeRecent(base, entry('c1', 'a', 9))
    expect(merged).toHaveLength(3)
    expect(merged[0]).toMatchObject({ connectionId: 'c1', database: 'a', ts: 9 })
    expect(merged.map((e) => recentKeyOf(e))).toEqual(['c1::a', 'c1::b', 'c2::a'])

    const many: RecentConnection[] = []
    for (let i = 0; i < 10; i++) many.push(entry('c' + i, null, i))
    expect(mergeRecent(many, entry('new', null, 99))).toHaveLength(8)
    expect(mergeRecent(many, entry('new', null, 99))[0].connectionId).toBe('new')
  })

  it('parseRecent 容错：空/损坏/异形按空或净化列表处理', () => {
    expect(parseRecent(null)).toEqual([])
    expect(parseRecent('')).toEqual([])
    expect(parseRecent('{bad json')).toEqual([])
    expect(parseRecent('{"a":1}')).toEqual([])
    expect(
      parseRecent(JSON.stringify([{ connectionId: 'c1', name: 1, dbType: 2, database: '', ts: 'x' }, { nope: 1 }, 'str']))
    ).toEqual([{ connectionId: 'c1', name: '', dbType: '', database: null, ts: 0 }])
  })

  it('parseRecent 清洗 UUID 形状的 name（展示层不露连接 ID）', () => {
    const raw = JSON.stringify([
      { connectionId: 'c1', name: 'a3f9c2e1-1111-2222-3333-444455556666', dbType: 'mysql', database: 'shop', ts: 5 },
      { connectionId: 'c2', name: '0f9e8d7c6b5a4321', dbType: 'mysql', database: null, ts: 5 },
      { connectionId: 'c3', name: '生产库', dbType: 'mysql', database: 'shop', ts: 5 }
    ])
    const list = parseRecent(raw)
    expect(list.map((e) => e.name)).toEqual(['', '', '生产库'])
    expect(list.every((e) => e.connectionId.length > 0)).toBe(true)
  })

  it('loadRecent 无桥/无数据返回空列表', async () => {
    expect(await loadRecent(null)).toEqual([])
    expect(await loadRecent(mkBridge())).toEqual([])
  })

  it('rememberConnection 写入并可回读，重复打开刷新置顶', async () => {
    const bridge = mkBridge()
    await rememberConnection(bridge, { connectionId: 'c1', name: '生产库', dbType: 'postgres', database: 'app' })
    await rememberConnection(bridge, { connectionId: 'c2', name: '测试', dbType: 'mysql' })
    const again = await rememberConnection(bridge, { connectionId: 'c1', name: '生产库2', dbType: 'postgres', database: 'app' })
    expect(again).toHaveLength(2)
    expect(again[0]).toMatchObject({ name: '生产库2', database: 'app' })
    const reloaded = await loadRecent(bridge)
    expect(reloaded.map((e) => e.connectionId)).toEqual(['c1', 'c2'])
  })

  it('rememberConnection 无 connectionId 不写入', async () => {
    const bridge = mkBridge()
    await rememberConnection(bridge, { name: 'x' })
    expect(bridge.storageSet).not.toHaveBeenCalled()
  })

  it('真实库名即使包含长英文数字或十六进制也完整保存与回读', async () => {
    const bridge = mkBridge()
    for (const database of ['Health_MySQL_2026_TEST', '0f9e8d7c6b5a4321']) {
      await rememberConnection(bridge, { connectionId: 'c1', name: '业务开发', dbType: 'mysql', database })
    }
    expect((await loadRecent(bridge)).map((item) => item.database)).toEqual(['0f9e8d7c6b5a4321', 'Health_MySQL_2026_TEST'])
  })

  it('表入口缺少名称时继承同一连接，切到其他库也不抹掉名称与类型', () => {
    const named = { ...entry('c1', 'shop', 1), name: '业务开发', dbType: 'mysql' }
    const merged = mergeRecent([named, entry('c2', 'shop', 2)], { connectionId: 'c1', name: '', dbType: '', database: 'reporting', ts: 3 })
    expect(merged.filter((item) => item.connectionId === 'c1').map((item) => [item.name, item.dbType])).toEqual([['业务开发', 'mysql'], ['业务开发', 'mysql']])
    expect(merged.find((item) => item.connectionId === 'c2')?.name).toBe('c2-name')
  })

  it('新的连接名称同步到同连接的所有库记录，旧列表不被修改', () => {
    const base = [entry('c1', 'shop', 1), entry('c1', 'reporting', 2), entry('c2', 'shop', 3)]
    const merged = mergeRecent(base, { ...entry('c1', 'shop', 4), name: '重命名业务连接' })
    expect(merged.filter((item) => item.connectionId === 'c1').every((item) => item.name === '重命名业务连接')).toBe(true)
    expect(base[0].name).toBe('c1-name')
  })

  it('旧记录的空名或占位名从同连接最新的有效名称修复', () => {
    const list = parseRecent(JSON.stringify([
      { ...entry('c1', 'shop', 3), name: '未命名连接' },
      { ...entry('c1', 'reporting', 2), name: '业务开发' },
      { ...entry('c1', 'archive', 1), name: '旧名称' },
      { ...entry('c2', 'shop', 4), name: '' }
    ]))
    expect(list.map((item) => item.name)).toEqual(['业务开发', '业务开发', '业务开发', ''])
  })

  it('真实的长英文连接名称不会因混合大小写与数字被隐藏', async () => {
    const bridge = mkBridge()
    await rememberConnection(bridge, { connectionId: 'c1', name: 'Health_MySQL_2026_TEST', dbType: 'mysql', database: 'shop' })
    expect((await loadRecent(bridge))[0].name).toBe('Health_MySQL_2026_TEST')
  })

  it('上下文补全只继承连接名称与类型，不替换实际数据库、Schema 和表', () => {
    const ctx = { connectionId: 'c1', database: 'active', schema: 'sales', table: 'orders' }
    const list = [{ ...entry('c1', 'old', 1), name: '业务开发' }, { ...entry('c2', 'active', 2), name: '另一连接' }]
    expect(contextWithRecent(ctx, list)).toEqual({ ...ctx, name: '业务开发', dbType: 'mysql' })
    expect(contextWithRecent({ ...ctx, name: '宿主新名称' }, list).name).toBe('宿主新名称')
  })

  it('并发记录不会丢失库入口或使有名连接退化为空名', async () => {
    const bridge = mkBridge()
    await Promise.all([
      rememberConnection(bridge, { connectionId: 'c1', name: '业务开发', dbType: 'mysql', database: 'shop' }),
      rememberConnection(bridge, { connectionId: 'c1', database: 'reporting' }),
      rememberConnection(bridge, { connectionId: 'c2', name: '数据分析', dbType: 'postgres', database: 'shop' })
    ])
    const list = await loadRecent(bridge)
    expect(list).toHaveLength(3)
    expect(list.filter((item) => item.connectionId === 'c1').every((item) => item.name === '业务开发')).toBe(true)
    expect(bridge.queryData).not.toHaveBeenCalled()
  })

  it('一次存储失败不会阻塞后续名称更新', async () => {
    const bridge = mkBridge()
    bridge.storageSet.mockRejectedValueOnce(new Error('存储故障'))
    await expect(rememberConnection(bridge, { connectionId: 'c1', name: '旧名称' })).rejects.toThrow('存储故障')
    await rememberConnection(bridge, { connectionId: 'c1', name: '恢复后的名称' })
    expect((await loadRecent(bridge))[0].name).toBe('恢复后的名称')
  })
})
