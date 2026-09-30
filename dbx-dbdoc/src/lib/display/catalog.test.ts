import { describe, expect, it } from 'vitest'
import type { DbTable } from '../dialects/entities'
import { selectCatalogTables, virtualRange, type CatalogOptions } from './catalog'
import { groupRows } from './groups'

const tables: DbTable[] = ['orders', 'users', 'logs'].map((name, i) => ({
  table_schema: i === 2 ? 'audit' : 'public', table_name: name, table_comment: i === 2 ? '' : '业务表',
  engine: '', table_collation: '', column_count: i + 1
}))
const options: CatalogOptions = { keyword: '', regexMode: false, schema: null, columnHits: new Set(), uncommented: false, sort: 'name' }
describe('目录搜索和虚拟滚动', () => {
  it('字段命中的表出现在目录结果，不要求表名也命中', () => {
    expect(selectCatalogTables(tables, { ...options, keyword: 'user_id', columnHits: new Set(['public.orders']) }).map((row) => row.table_name)).toEqual(['orders'])
  })
  it('字段命中也遵循 Schema 和无注释筛选', () => {
    expect(selectCatalogTables(tables, { ...options, keyword: 'id', columnHits: new Set(['public.users']), schema: 'audit' })).toEqual([])
    expect(selectCatalogTables(tables, { ...options, uncommented: true })).toEqual([tables[2]])
  })
  it('无效正则不显示全部表，正则模式不混入字面字段搜索结果', () => {
    expect(selectCatalogTables(tables, { ...options, keyword: '[', regexMode: true })).toEqual([])
    expect(selectCatalogTables(tables, { ...options, keyword: '^users$', regexMode: true, columnHits: new Set(['public.orders']) }).map((row) => row.table_name)).toEqual(['users'])
  })
  it('字段数排序不改变原目录', () => {
    expect(selectCatalogTables(tables, { ...options, sort: 'columns' }).map((row) => row.table_name)).toEqual(['logs', 'users', 'orders'])
    expect(tables[0].table_name).toBe('orders')
  })
  it('5000 张表仅保留视口附近的行，列表缩小时范围仍有效', () => {
    const range = virtualRange(5000, 72000, 720)
    expect(range.end - range.start).toBeLessThanOrEqual(18)
    expect(range.before + (range.end - range.start) * 72 + range.after).toBe(5000 * 72)
    expect(virtualRange(2, 72000, 720)).toEqual({ start: 0, end: 2, before: 0, after: 0 })
  })
  it('联合索引与联合外键按名称分组并保持字段顺序', () => {
    const groups = groupRows([{ name: 'idx', seq: 2 }, { name: 'idx', seq: 1 }, { name: 'other', seq: 1 }], (row) => row.name)
    expect(groups).toHaveLength(2)
    expect(groups[0].rows.map((row) => row.seq)).toEqual([1, 2])
  })
})
