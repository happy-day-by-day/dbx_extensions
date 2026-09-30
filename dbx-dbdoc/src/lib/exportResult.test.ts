import { describe, expect, it } from 'vitest'
import { mergeExportResult, remainingExportTables, renderExportResult } from './exportResult'
import type { DbTable } from './dialects/entities'
import type { TableDetail } from './markdown'
import type { ExportSchemaResult } from './store'

const table = (schema: string, name: string): DbTable => ({ table_schema: schema, table_name: name, table_comment: '', engine: '', table_collation: '', column_count: 1 })
const detail = (row: DbTable): TableDetail => ({ table: row, columns: [], indexes: [], constraints: [] })
const tables = [table('public', 'orders'), table('sales', 'orders'), table('sales', 'customers')]
const initial: ExportSchemaResult = { details: [detail(tables[0])], failed: [{ schema: 'sales', table: 'orders', message: 'closed' }] }

describe('可继续生成的数据库导出', () => {
  it('只重试缺少的表，区分跨 Schema 同名表并包含未开始的任务', () => {
    expect(remainingExportTables(tables, initial.details)).toEqual(tables.slice(1))
  })
  it('补全成功后清除相应失败，保留已有结果并恢复最初的表顺序', () => {
    const merged = mergeExportResult(tables, initial, { details: [detail(tables[2]), detail(tables[1])], failed: [] })
    expect(merged.details.map((row) => row.table)).toEqual(tables)
    expect(merged.failed).toEqual([])
    expect(remainingExportTables(tables, merged.details)).toEqual([])
    expect(initial.failed).toHaveLength(1)
    expect(initial.details).toHaveLength(1)
  })
  it('再次失败采用最新错误，停止时未重试的旧失败不会丢失', () => {
    const failed = mergeExportResult(tables, initial, { details: [], failed: [{ schema: 'sales', table: 'orders', message: 'denied' }] })
    expect(failed.failed[0].message).toBe('denied')
    const stopped = mergeExportResult(tables, failed, { details: [detail(tables[2])], failed: [] })
    expect(stopped.failed).toEqual(failed.failed)
    expect(remainingExportTables(tables, stopped.details)).toEqual([tables[1]])
  })
  it('忽略范围外的返回结果，补全不重复生成已完成的表', () => {
    const other = table('other', 'orders')
    const merged = mergeExportResult(tables, initial, { details: [detail(other), detail(tables[0])], failed: [{ schema: 'other', table: 'orders', message: 'error' }] })
    expect(merged.details).toHaveLength(1)
    expect(merged.failed).toEqual(initial.failed)
  })
  it('部分文档区分失败和未读取，补全后移除不完整提示并保留实际库名', () => {
    const partial = renderExportResult('Health_MySQL_2026_TEST', initial, 'postgres', 3, false, true)
    expect(partial).toContain('1/3 张已加载表；生成已停止。1 张表读取失败。1 张表尚未读取。')
    expect(partial).toContain('# Health_MySQL_2026_TEST 数据字典')
    const complete = mergeExportResult(tables, initial, { details: tables.slice(1).map(detail), failed: [] })
    expect(renderExportResult('shop', complete, 'postgres', 3, false, false)).not.toContain('本文档包含')
    expect(renderExportResult('shop', complete, 'postgres', 3, true, false)).toContain('表清单被宿主截断')
    expect(renderExportResult('shop', { details: [], failed: [] }, 'postgres', 3, false, true)).toBe('')
  })
})
