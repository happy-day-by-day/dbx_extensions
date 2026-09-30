import { describe, expect, it, vi } from 'vitest'
import { connectionMatches, groupConnections, mergeDatabases, currentSessionDatabase, verifyDatabaseSession } from './resources'
import type { DbxBridge } from './types'
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
