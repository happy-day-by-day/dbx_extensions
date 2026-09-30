import { describe, expect, it } from 'vitest'
import { mysqlAdapter } from './mysql'
import { rowsToObjects } from './shared'

const ref = { db: 'shop', schema: null, table: null }

describe('mysqlAdapter SQL', () => {
  it('listTables 指定库时按 TABLE_SCHEMA 过滤', () => {
    const sql = mysqlAdapter.listTables(ref)
    expect(sql).toContain('INFORMATION_SCHEMA.TABLES')
    expect(sql).toContain("TABLE_SCHEMA = 'shop'")
    expect(sql).toContain('BASE TABLE')
    expect(sql).toContain('GROUP BY TABLE_SCHEMA, TABLE_NAME')
    expect(sql).toContain("t.TABLE_SCHEMA = 'shop'")
    expect(sql).not.toContain('(SELECT COUNT(*)')
  })
  it('listTables 无库时用 DATABASE() 且排除系统库', () => {
    const sql = mysqlAdapter.listTables({ db: null, schema: null, table: null })
    expect(sql).toContain('TABLE_SCHEMA = DATABASE()')
    expect(sql).toContain("'INFORMATION_SCHEMA','MYSQL','PERFORMANCE_SCHEMA','SYS'")
  })
  it('listColumns 按表过滤且转义单引号', () => {
    const sql = mysqlAdapter.listColumns(ref, "order's")
    expect(sql).toContain("TABLE_NAME = 'order''s'")
  })
  it('listIndexesLegacy 存在（旧版本无 EXPRESSION 列）', () => {
    expect(typeof mysqlAdapter.listIndexesLegacy).toBe('function')
  })
  it('listForeignKeys 多表联查以 kcu 别名限定过滤（避免歧义列 ERROR 1052）', () => {
    const sql = mysqlAdapter.listForeignKeys(ref, 'orders')
    expect(sql).toContain("kcu.TABLE_SCHEMA = 'shop'")
    expect(sql).toContain("kcu.TABLE_NAME = 'orders'")
    // 未限定的 TABLE_SCHEMA/TABLE_NAME 过滤不应再出现
    expect(sql).not.toContain(' TABLE_SCHEMA =')
    expect(sql).not.toContain(' TABLE_NAME =')
  })
  it('listForeignKeys 无库时以 kcu.TABLE_SCHEMA = DATABASE() 限定', () => {
    const sql = mysqlAdapter.listForeignKeys({ db: null, schema: null, table: null }, 'orders')
    expect(sql).toContain('kcu.TABLE_SCHEMA = DATABASE()')
    expect(sql).toContain("kcu.TABLE_NAME = 'orders'")
  })
  it('listChecks 的 WHERE 也以 tc 别名限定', () => {
    const sql = mysqlAdapter.listChecks(ref, 'orders')
    expect(sql).toContain("tc.TABLE_SCHEMA = 'shop'")
    expect(sql).toContain("tc.TABLE_NAME = 'orders'")
  })
  it('searchColumns 生成 LIKE 查询并转义通配符', () => {
    const sql = mysqlAdapter.searchColumns(ref, '100%_done')
    expect(sql).toContain("LIKE '%100\\%\\_done%'")
    expect(sql).toContain('COLUMN_COMMENT')
  })
})

describe('mysqlAdapter mappers', () => {
  it('mapTable 映射列数与注释缺省', () => {
    const result = {
      columns: [{ name: 'table_schema' }, { name: 'table_name' }, { name: 'table_comment' }, { name: 'engine' }, { name: 'table_collation' }, { name: 'column_count' }],
      rows: [['shop', 'orders', null, 'InnoDB', 'utf8mb4_general_ci', 5]]
    }
    const [row] = rowsToObjects(result)
    const table = mysqlAdapter.mapTable(row)
    expect(table).toMatchObject({ table_schema: 'shop', table_name: 'orders', table_comment: '', column_count: 5, engine: 'InnoDB' })
  })
  it('mapColumn 解析 extra 中的生成列与自增语义', () => {
    const result = {
      columns: ['table_schema', 'table_name', 'column_name', 'extra', 'column_comment', 'column_type', 'data_type', 'column_default', 'column_key', 'is_nullable', 'length', 'scale', 'ordinal_position', 'character_set_name', 'collation_name', 'generation_expression'].map((name) => ({ name })),
      rows: [['shop', 'orders', 'full_name', 'STORED GENERATED', '冗余', 'varchar(64)', 'varchar', null, '', 'NO', 64, null, 3, 'utf8mb4', 'utf8mb4_general_ci', "concat(first_name,' ',last_name)"]]
    }
    const column = mysqlAdapter.mapColumn(rowsToObjects(result)[0])
    expect(column.generated_storage).toBe('STORED')
    expect(column.generation_expression).toContain('concat')
    expect(column.is_nullable).toBe('NO')
  })
  it('mapIndex 识别主键与唯一索引', () => {
    const result = {
      columns: ['table_schema', 'table_name', 'column_name', 'seq', 'index_name', 'index_type', 'index_comment', 'non_unique', 'collation', 'sub_part', 'expression'].map((name) => ({ name })),
      rows: [['shop', 'orders', 'id', 1, 'PRIMARY', 'BTREE', '', 0, 'A', null, null]]
    }
    const index = mysqlAdapter.mapIndex(rowsToObjects(result)[0])
    expect(index.is_primary).toBe(true)
    expect(index.is_unique).toBe(true)
    expect(index.non_unique).toBe('0')
  })
})

describe('mysqlAdapter listDatabases', () => {
  it('枚举库并排除系统库', () => {
    const sql = mysqlAdapter.listDatabases!(ref)
    expect(sql).toContain('INFORMATION_SCHEMA.SCHEMATA')
    expect(sql).toContain("NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')")
    expect(sql).toContain('ORDER BY SCHEMA_NAME')
  })
})
