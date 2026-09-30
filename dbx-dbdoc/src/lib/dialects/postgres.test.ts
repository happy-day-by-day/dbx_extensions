import { describe, expect, it } from 'vitest'
import { postgresAdapter } from './postgres'

const ref = { db: 'app', schema: 'public', table: 'orders' }

describe('postgresAdapter', () => {
  it('listTables 排除系统 schema 且为 BASE TABLE', () => {
    const sql = postgresAdapter.listTables(ref)
    expect(sql).toContain("table_schema NOT IN ('pg_catalog', 'information_schema')")
    expect(sql).toContain("table_type = 'BASE TABLE'")
    expect(sql).toContain('obj_description')
  })
  it('listColumns 按 schema+table 过滤并带 col_description/format_type', () => {
    const sql = postgresAdapter.listColumns(ref, 'orders')
    expect(sql).toContain("c.table_schema = 'public'")
    expect(sql).toContain("c.table_name = 'orders'")
    expect(sql).toContain('col_description')
    expect(sql).toContain('format_type')
  })
  it('listIndexes 含 pg_index 展开、主键与谓词', () => {
    const sql = postgresAdapter.listIndexes(ref, 'orders')
    expect(sql).toContain('pg_index')
    expect(sql).toContain('unnest(idx.indkey)')
    expect(sql).toContain('indisprimary')
    expect(sql).toContain('pg_get_expr')
  })
  it('listForeignKeys/listChecks 是独立单语句', () => {
    expect(postgresAdapter.listForeignKeys(ref, 'orders')).toContain("contype = 'f'")
    expect(postgresAdapter.listChecks(ref, 'orders')).toContain("contype = 'c'")
  })
  it('searchColumns 使用 ILIKE', () => {
    const sql = postgresAdapter.searchColumns(ref, '订单%名')
    expect(sql).toContain('ILIKE')
    expect(sql).toContain("'%订单\\%名%'")
  })
  it('mapColumn 识别 identity 与生成列', () => {
    const column = postgresAdapter.mapColumn({
      table_schema: 'public', table_name: 'orders', column_name: 'id', extra: 'IDENTITY',
      column_comment: '主键', column_type: 'bigint', data_type: 'bigint', column_default: null,
      is_nullable: 'NO', ordinal_position: 1, length: 64, scale: null,
      character_set_name: null, collation_name: null,
      is_identity: 'YES', identity_generation: 'BY DEFAULT', identity_start: '1', identity_increment: '1',
      is_generated: 'NO', generation_expression: null
    })
    expect(column.is_identity).toBe(true)
    expect(column.identity_generation).toBe('BY DEFAULT')
    expect(column.generated_storage).toBeNull()
  })
})
