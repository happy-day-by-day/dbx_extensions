import { describe, expect, it } from 'vitest'
import type { DbTable } from '../dialects/entities'
import {
  CATALOG_FILTER_DIMENSIONS,
  buildTableSearchIndex,
  compileFilterPattern,
  filterDatabaseTables
} from './filters'

const tables: DbTable[] = [
  { table_schema: 'public', table_name: 'orders', table_comment: '订单主表', engine: '', table_collation: '', column_count: 2 },
  { table_schema: 'audit', table_name: 'audit_logs', table_comment: '操作日志', engine: '', table_collation: '', column_count: 2 }
]

const shopTables: DbTable[] = [
  { table_schema: 'shop', table_name: 'orders', table_comment: '订单表', engine: '', table_collation: '', column_count: 3 },
  { table_schema: 'shop', table_name: 'users', table_comment: '', engine: '', table_collation: '', column_count: 2 }
]

describe('filters', () => {
  it('目录过滤维度固定为表名/表注释/schema 三维', () => {
    expect(CATALOG_FILTER_DIMENSIONS).toEqual({ tableName: true, tableComment: true, schema: true })
  })

  it('按表注释过滤（三维任一命中即保留）', () => {
    const result = filterDatabaseTables(tables, '操作日志', false)
    expect(result.map((table) => table.table_name)).toEqual(['audit_logs'])
  })

  it('构建小写化的三维搜索索引（schema 维含 schema 与 schema.table 拼接串）', () => {
    expect(buildTableSearchIndex(tables[0])).toEqual({
      tableName: 'orders',
      tableComment: '订单主表',
      schema: 'public\npublic.orders'
    })
  })

  it('按 schema 与限定名过滤', () => {
    const result = filterDatabaseTables(tables, 'audit.audit_logs', false)
    expect(result.map((table) => table.table_name)).toEqual(['audit_logs'])
  })

  it('普通关键词按表名/注释/schema 过滤（大小写不敏感）', () => {
    expect(filterDatabaseTables(shopTables, 'ORDER', false)).toHaveLength(1)
    expect(filterDatabaseTables(shopTables, '订单', false)).toHaveLength(1)
    expect(filterDatabaseTables(shopTables, 'shop.users', false)).toHaveLength(1)
  })

  it('无关键词返回全部（原数组引用）', () => {
    expect(filterDatabaseTables(shopTables, '', false)).toBe(shopTables)
  })

  it('非正则模式下关键词按字面量转义', () => {
    const state = compileFilterPattern('order[2026].*', false)
    expect(state.error).toBe('')
    expect(state.regex?.test('order[2026].*')).toBe(true)
    expect(state.regex?.test('order2xxx')).toBe(false)
  })

  it('正则模式大小写不敏感地过滤表名', () => {
    const result = filterDatabaseTables(tables, '^AUDIT_.*$', true)
    expect(result.map((table) => table.table_name)).toEqual(['audit_logs'])
  })

  it('非法正则报错且保留全部结果', () => {
    const state = compileFilterPattern('[orders', true)
    expect(state.regex).toBeNull()
    expect(state.error).toMatch(/^正则表达式无效：/)
    expect(filterDatabaseTables(tables, '[orders', true)).toBe(tables)
    expect(filterDatabaseTables(shopTables, '[', true)).toHaveLength(2)
  })
})
