import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getBridge 现为单例（模块级缓存），测试需每个用例重取新模块实例，
// 否则前一个用例缓存的 bridge 会泄漏到「无宿主返回 null」等用例。
const importBridge = async (): Promise<typeof import('./bridge')> => {
  vi.resetModules()
  return await import('./bridge')
}

const mkHost = () => ({
  ready: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ connectionId: 'c1', dbType: 'mysql' }),
  onContext: vi.fn(),
  queryData: vi.fn().mockResolvedValue({
    dbType: 'mysql',
    columns: [{ name: 'n', dataType: 'varchar' }],
    rows: [['a']],
    truncated: false
  }),
  getTableMetadata: vi.fn().mockResolvedValue({ columns: [] }),
  storage: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
  locale: 'zh-CN',
  theme: 'light',
  capabilities: { dataApi: true, schemaMetadataApi: true, storage: true, clipboardWrite: true },
  copy: vi.fn().mockResolvedValue(undefined)
})

describe('bridge', () => {
  it('opens a new scoped query workbench without executing SQL', async () => {
    const { getBridge } = await importBridge()
    const host = { ...mkHost(), contributionId: 'com.sazs.dbdoc.query', openWorkbench: vi.fn().mockResolvedValue(undefined) }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const context = { connectionId: 'c1', dbType: 'postgres', database: 'appdb', schema: 'sales', table: 'orders' }
    const bridge = getBridge()!
    expect(bridge.getContributionId?.()).toBe('com.sazs.dbdoc.query')
    await bridge.openTableQuery!(context)
    expect(host.openWorkbench).toHaveBeenCalledWith('com.sazs.dbdoc.query', context, { forceNew: true, target: 'tab' })
    expect(host.queryData).not.toHaveBeenCalled()
  })
  it('reports unsupported navigation without sending guessed host requests', async () => {
    const { getBridge } = await importBridge()
    const host = { ...mkHost(), request: vi.fn() }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    await expect(getBridge()!.openTableQuery!({ connectionId: 'c1', dbType: 'mysql', table: 'orders' })).rejects.toThrow('升级 DBX')
    expect(host.request).not.toHaveBeenCalled()
    expect(host.queryData).not.toHaveBeenCalled()
  })
  it('surfaces host navigation rejection and validates the selected table', async () => {
    const { getBridge } = await importBridge()
    const host = { ...mkHost(), openWorkbench: vi.fn().mockRejectedValue(new Error('导航被拒绝')) }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()!
    await expect(bridge.openTableQuery!({ connectionId: 'c1', dbType: 'mysql' })).rejects.toThrow('缺少查询表名')
    expect(host.openWorkbench).not.toHaveBeenCalled()
    await expect(bridge.openTableQuery!({ connectionId: 'c1', dbType: 'mysql', table: 'orders' })).rejects.toThrow('导航被拒绝')
  })
  it('等待官方 Promise ready，再读取对象 context 与动态能力位', async () => {
    const { getBridge } = await importBridge()
    let resolveReady!: () => void
    const host: any = { ...mkHost(), ready: new Promise<void>((resolve) => { resolveReady = resolve }), context: { id: 'real', dbType: 'mysql', database: 'shop' }, capabilities: {}, storage: undefined }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()!
    let ready = false
    const pending = bridge.ready().then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)
    host.capabilities.dataApi = true
    host.capabilities.storage = true
    host.storage = { get: vi.fn().mockResolvedValue({ width: 300 }), set: vi.fn().mockResolvedValue(undefined) }
    resolveReady()
    await pending
    expect(bridge.capabilities?.dataApi).toBe(true)
    expect((await bridge.getContext())?.connectionId).toBe('real')
    expect(await bridge.storageGet('prefs')).toBe('{"width":300}')
    await bridge.storageSet('prefs', 'updated')
    expect(host.storage.set).toHaveBeenCalledWith('prefs', 'updated')
  })
  it('官方主题对象与宿主剪贴板，不依赖沙箱 navigator.clipboard', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), theme: { appearance: 'dark', tokens: {} } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()!
    expect(await bridge.getTheme()).toBe('dark')
    expect(await bridge.copyText('字段😀')).toBe(true)
    expect(host.copy).toHaveBeenCalledWith('字段😀')
  })
  it('能力位缺失时不发送探测查询', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), capabilities: {} }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    await expect(getBridge()!.queryData({ connectionId: 'c1', sql: 'SELECT 1' })).rejects.toThrow('升级 DBX')
    expect(host.queryData).not.toHaveBeenCalled()
  })
  it('取消保存没有写入；写入失败会释放句柄', async () => {
    const { getBridge } = await importBridge()
    const ft = { beginSave: vi.fn().mockResolvedValue(null), write: vi.fn().mockRejectedValue(new Error('磁盘错误')), finish: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) }
    Object.assign(globalThis, { window: { dbxPlugin: { ...mkHost(), fileTransfer: ft } } })
    const bridge = getBridge()!
    expect(await bridge.saveFile('doc.md', '中文')).toBe('cancelled')
    expect(ft.write).not.toHaveBeenCalled()
    ft.beginSave.mockResolvedValue({ handleId: 'h1', chunkBytes: 64 })
    expect(await bridge.saveFile('doc.md', '中文')).toBe('failed')
    expect(ft.cancel).toHaveBeenCalledWith('h1')
  })
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('无宿主时 getBridge 返回 null 且不缓存 null（宿主后注入可再取到）', async () => {
    const { getBridge } = await importBridge()
    expect(getBridge()).toBeNull()
    Object.assign(globalThis, { window: { dbxPlugin: mkHost() } })
    expect(getBridge()).not.toBeNull()
  })

  it('桥接宿主方法并透传 queryData 结果', async () => {
    const { getBridge } = await importBridge()
    const host = mkHost()
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    expect(bridge).not.toBeNull()
    const result = await bridge!.queryData({ connectionId: 'c1', sql: 'SELECT 1' })
    expect(result.rows).toEqual([['a']])
    expect(host.queryData).toHaveBeenCalledWith({ connectionId: 'c1', sql: 'SELECT 1' })
    await bridge!.ready()
    expect(await bridge!.getContext()).toEqual({ connectionId: 'c1', dbType: 'mysql' })
  })

  it('getContext 归一连接 summary 的顶层 id 形态（文档：id/dbType/name/database）', async () => {
    const { getBridge } = await importBridge()
    const host = mkHost()
    host.context = vi.fn().mockResolvedValue({ id: 'conn-9', dbType: 'postgres', name: '生产 PG', database: 'app' })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    expect(await bridge!.getContext()).toEqual({
      connectionId: 'conn-9', dbType: 'postgres', name: '生产 PG', database: 'app',
      schema: undefined, table: undefined
    })
  })

  it('getContext 归一 JSON 字符串与 connection 字符串形态', async () => {
    const { getBridge } = await importBridge()
    const host = mkHost()
    host.context = vi.fn().mockResolvedValueOnce('{"id":"cx","dbType":"mysql"}').mockResolvedValueOnce({ connection: 'cy', dbType: 'mysql' })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    expect((await bridge!.getContext())!.connectionId).toBe('cx')
    expect((await bridge!.getContext())!.connectionId).toBe('cy')
  })

  it('明确连接名称优先于上下文对象名称，并保留长英文名称', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), context: { connectionId: 'c1', name: 'orders', connectionName: 'Health_MySQL_2026_TEST', database: 'shop', table: 'orders' } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    expect((await getBridge()!.getContext())?.name).toBe('Health_MySQL_2026_TEST')
  })

  it('摘要名称为空或为连接 ID 时继续采用外层有效连接名称', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), context: { connection: { id: 'c1', name: 'c1' }, connectionName: '业务开发环境' } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    expect((await getBridge()!.getContext())?.name).toBe('业务开发环境')
  })

  it('表上下文中的通用 name、title、label 不作为连接名称，库路径保持不变', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), context: { connectionId: 'c1', dbType: 'mysql', name: ' orders ', title: 'orders', label: 'orders', database: 'shop', table: 'orders' } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    expect(await getBridge()!.getContext()).toEqual({ connectionId: 'c1', dbType: 'mysql', name: undefined, database: 'shop', schema: undefined, table: 'orders' })
  })

  it('活动数据库上下文优先于嵌套连接摘要中的旧默认库', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), context: { connection: { id: 'c1', dbType: 'mysql', name: '业务连接', database: 'closed', schema: 'old', table: 'old_table' }, database: 'active', schema: 'sales', table: 'orders' } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    expect(await getBridge()!.getContext()).toEqual({ connectionId: 'c1', dbType: 'mysql', name: '业务连接', database: 'active', schema: 'sales', table: 'orders' })
  })

  it('没有外层数据库时仍可使用嵌套连接摘要', async () => {
    const { getBridge } = await importBridge()
    const host: any = { ...mkHost(), context: { connection: { id: 'c1', dbType: 'mysql', database: 'default' } } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    expect((await getBridge()!.getContext())?.database).toBe('default')
  })

  it('将未打开会话与授权拒绝、超时等错误区分', async () => {
    const { isConnectionNotOpen } = await importBridge()
    expect(isConnectionNotOpen(new Error('Connection is not open'))).toBe(true)
    expect(isConnectionNotOpen({ message: 'Server error: Connection is not open' })).toBe(true)
    expect(isConnectionNotOpen('Database session is not open')).toBe(true)
    expect(isConnectionNotOpen('PLUGIN_DATA_ACCESS_NOT_GRANTED')).toBe(false)
    expect(isConnectionNotOpen(new Error('查询超时'))).toBe(false)
    expect(isConnectionNotOpen(null)).toBe(false)
  })

  it('宿主无 onContext 时经 onEvent 投递的上下文也能收到', async () => {
    const { getBridge } = await importBridge()
    const host: any = mkHost()
    delete host.onContext
    let onEventCb: any = null
    host.onEvent = vi.fn((cb: any) => { onEventCb = cb })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    const got: unknown[] = []
    bridge!.onContextChange((ctx) => got.push(ctx))
    onEventCb({ type: 'context', detail: { id: 'cz', dbType: 'mysql', database: 'shop' } })
    expect(got).toEqual([{ connectionId: 'cz', dbType: 'mysql', name: undefined, database: 'shop', schema: undefined, table: undefined }])
  })

  it('未识别的上下文载荷记录进诊断（getLastUnrecognizedContext）', async () => {
    const { getBridge, getLastUnrecognizedContext } = await importBridge()
    const host = mkHost()
    host.context = vi.fn().mockResolvedValue({ foo: 'bar', nested: { x: 1 } })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    expect(await bridge!.getContext()).toBeNull()
    expect(getLastUnrecognizedContext()).toContain('foo')
  })

  it('「认出形状但无连接无表」的载荷不再被静默吞掉，进诊断并通知订阅者', async () => {
    const { getBridge, onUnrecognizedContext, getLastUnrecognizedContext } = await importBridge()
    const host = mkHost()
    let hostCb: ((ctx: unknown) => void) | null = null
    host.onContext = vi.fn((cb: (ctx: unknown) => void) => { hostCb = cb })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    const events: (string | null)[] = []
    const off = onUnrecognizedContext((msg) => events.push(msg))
    const got: unknown[] = []
    bridge!.onContextChange((ctx) => got.push(ctx))
    // 宿主 summary 形态：有 name 无 id/connectionId——归一化能吃下但没有连接标识
    hostCb!({ type: 'summary', name: '生产 PG', dbType: 'postgres' })
    expect(got).toEqual([])
    expect(events.length).toBe(1)
    expect(events[0]).toContain('onContext')
    expect(events[0]).toContain('生产 PG')
    expect(getLastUnrecognizedContext()).toBe(events[0])
    off()
  })

  it('onUnrecognizedContext 退订后不再收到通知', async () => {
    const { getBridge, onUnrecognizedContext } = await importBridge()
    const host = mkHost()
    let hostCb: ((ctx: unknown) => void) | null = null
    host.onContext = vi.fn((cb: (ctx: unknown) => void) => { hostCb = cb })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    getBridge()
    const events: (string | null)[] = []
    const off = onUnrecognizedContext((msg) => events.push(msg))
    off()
    hostCb!({ whatever: 1 })
    expect(events).toEqual([])
  })

  it('宿主无 onContext 时 onInit 通道投递的上下文也能收到', async () => {
    const { getBridge } = await importBridge()
    const host: any = mkHost()
    delete host.onContext
    let onInitCb: any = null
    host.onInit = vi.fn((cb: any) => { onInitCb = cb })
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    const got: unknown[] = []
    bridge!.onContextChange((ctx) => got.push(ctx))
    onInitCb({ context: { connectionId: 'ci', dbType: 'mysql', database: 'shop' } })
    expect(got).toEqual([{ connectionId: 'ci', dbType: 'mysql', name: undefined, database: 'shop', schema: undefined, table: undefined }])
  })

  it('getBridge 单例：重复调用返回同一实例，宿主监听器只挂一次', async () => {
    const { getBridge } = await importBridge()
    const host = mkHost()
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const first = getBridge()
    const second = getBridge()
    expect(first).toBe(second)
    expect(host.onContext).toHaveBeenCalledTimes(1)
  })

  it('isDataAccessDenied 识别授权拒绝错误（Error / 纯字符串 / message 对象，包含匹配）', async () => {
    const { isDataAccessDenied } = await importBridge()
    expect(isDataAccessDenied(new Error('PLUGIN_DATA_ACCESS_NOT_GRANTED: 拒绝'))).toBe(true)
    // 宿主可能把拒绝码包在前缀说明里：放宽为 includes 判定
    expect(isDataAccessDenied(new Error('host error: PLUGIN_DATA_ACCESS_NOT_GRANTED'))).toBe(true)
    expect(isDataAccessDenied('PLUGIN_DATA_ACCESS_NOT_GRANTED: 拒绝')).toBe(true)
    expect(isDataAccessDenied({ message: 'PLUGIN_DATA_ACCESS_NOT_GRANTED' })).toBe(true)
    expect(isDataAccessDenied({ code: 'PLUGIN_DATA_ACCESS_NOT_GRANTED' })).toBe(true)
    expect(isDataAccessDenied(new Error('timeout'))).toBe(false)
    expect(isDataAccessDenied('timeout')).toBe(false)
    expect(isDataAccessDenied({ message: 'boom' })).toBe(false)
    expect(isDataAccessDenied(42)).toBe(false)
    expect(isDataAccessDenied(null)).toBe(false)
  })

  it('chunkText 不把代理对（emoji）切在块边界', async () => {
    const { chunkText } = await importBridge()
    // 小块行为：高代理落在块尾时长度减 1，代理对完整进入下一块
    expect(chunkText('a😀b', 2)).toEqual(['a', '😀', 'b'])
    // 拼回原文无损
    expect(chunkText('a😀b', 2).join('')).toBe('a😀b')
    // 生产块大小（512KiB）边界：高代理恰在 524288 号位（下标 524287）
    const big = 'a'.repeat(512 * 1024 - 1) + '😀' + 'b'.repeat(3)
    const chunks = chunkText(big, 512 * 1024)
    expect(chunks.length).toBe(2)
    expect(chunks[0].length).toBe(512 * 1024 - 1)
    // 没有块以孤立高代理结尾，且拼回无损
    for (const chunk of chunks) {
      const tail = chunk.charCodeAt(chunk.length - 1)
      expect(tail < 0xd800 || tail > 0xdbff).toBe(true)
    }
    expect(chunks.join('')).toBe(big)
  })

  it('saveFile 按 UTF-8 字节和字节偏移写入，中文与 emoji 无损', async () => {
    const { getBridge } = await importBridge()
    const writes: Uint8Array[] = []
    const offsets: number[] = []
    const host = { ...mkHost(), fileTransfer: { beginSave: vi.fn().mockResolvedValue({ handleId: 'h1', chunkBytes: 64 }), write: vi.fn(async (_h: unknown, offset: number, chunk: Uint8Array) => { offsets.push(offset); writes.push(chunk) }), finish: vi.fn().mockResolvedValue(undefined) } }
    Object.assign(globalThis, { window: { dbxPlugin: host } })
    const bridge = getBridge()
    // 高代理恰在 512KiB 边界：若直接按块切片，emoji 会被切坏
    const content = 'a'.repeat(63) + '😀表数据字典'
    const outcome = await bridge!.saveFile('doc.md', content)
    expect(outcome).toBe('saved')
    expect(writes.length).toBe(2)
    const bytes = new Uint8Array(writes.reduce((total, chunk) => total + chunk.length, 0))
    writes.forEach((chunk, i) => bytes.set(chunk, offsets[i]))
    expect(new TextDecoder().decode(bytes)).toBe(content)
    expect(offsets).toEqual([0, 64])
    expect(host.fileTransfer.beginSave).toHaveBeenCalledWith({ name: 'doc.md', contentType: 'text/markdown;charset=utf-8', size: bytes.length })
    expect(host.fileTransfer.finish).toHaveBeenCalledWith('h1')
  })

  it('宿主对象引用变化（重注入）时 getBridge 重建桥，不返回旧桥', async () => {
    const { getBridge } = await importBridge()
    const first = mkHost()
    Object.assign(globalThis, { window: { dbxPlugin: first } })
    const bridgeA = getBridge()
    expect(getBridge()).toBe(bridgeA)
    // 同一引用：仍然单例
    Object.assign(globalThis, { window: { dbxPlugin: first } })
    expect(getBridge()).toBe(bridgeA)
    // 引用变化：重建（新桥可正常查询）
    Object.assign(globalThis, { window: { dbxPlugin: mkHost() } })
    const bridgeB = getBridge()
    expect(bridgeB).not.toBe(bridgeA)
    const result = await bridgeB!.queryData({ connectionId: 'c1', sql: 'SELECT 1' })
    expect(result.rows).toEqual([['a']])
  })
})
