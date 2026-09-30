import { describe, expect, it } from 'vitest'
import { mssqlAdapter } from './mssql'

const ref = { db: 'master', schema: 'dbo', table: 'Orders' }

describe('mssqlAdapter', () => {
  it('listTables 用扩展属性作表注释', () => {
    const sql = mssqlAdapter.listTables(ref)
    expect(sql).toContain('sys.tables')
    expect(sql).toContain("N'MS_Description'")
    expect(sql).toContain('column_count')
  })
  it('listColumns 拼接类型长度并识别 identity/computed', () => {
    const sql = mssqlAdapter.listColumns(ref, 'Orders')
    expect(sql).toContain("c.TABLE_SCHEMA = 'dbo'")
    expect(sql).toContain('sys.identity_columns')
    expect(sql).toContain('sys.computed_columns')
  })
  it('listIndexes 区分主键与唯一约束', () => {
    const sql = mssqlAdapter.listIndexes(ref, 'Orders')
    expect(sql).toContain('sys.indexes')
    expect(sql).toContain('is_primary_key')
    expect(sql).toContain('filter_definition')
  })
  it('mapColumn 处理 (max) 长度与 identity', () => {
    const column = mssqlAdapter.mapColumn({
      table_schema: 'dbo', table_name: 'Orders', column_name: 'note', extra: null,
      column_comment: '备注', column_type: 'nvarchar(max)', data_type: 'nvarchar', column_default: null,
      column_key: '', is_nullable: 'YES', ordinal_position: 3, length: -1, scale: null,
      character_set_name: null, collation_name: 'Chinese_PRC_CI_AS',
      is_identity: 1, identity_seed: 1, identity_increment: 1,
      is_computed: 0, generation_expression: null, is_persisted: 0
    })
    expect(column.column_type).toBe('nvarchar(max)')
    expect(column.is_identity).toBe(true)
    expect(column.identity_seed).toBe('1')
  })
  it('mapIndex 的 collation 映射方向', () => {
    const index = mssqlAdapter.mapIndex({
      table_schema: 'dbo', table_name: 'Orders', column_name: 'id', seq: 1,
      index_name: 'PK_Orders', index_type: 'CLUSTERED', index_comment: '', non_unique: '0',
      is_descending_key: 1, is_primary_key: 1, is_unique_constraint: 0, is_unique: 1,
      is_included_column: 0, predicate: ''
    })
    expect(index.collation).toBe('DESC')
    expect(index.is_primary).toBe(true)
  })
})

describe('mssqlAdapter listDatabases', () => {
  it('枚举在线库并排除系统库', () => {
    const sql = mssqlAdapter.listDatabases!({ db: null, schema: null, table: null })
    expect(sql).toContain('sys.databases')
    expect(sql).toContain("NOT IN ('master', 'model', 'msdb', 'tempdb')")
    expect(sql).toContain('state = 0')
  })
})
