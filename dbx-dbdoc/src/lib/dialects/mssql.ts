// SQL Server 方言适配器：移植自 data-watcher apps/dbdoc/infrastructure/databases/mssql.py。
// 移植规则：IN (%s...) 动态占位（schemas 列表）改为 schema 等值过滤（无值时排除系统 schema）；
// 详情查询叠加表名等值过滤；约束 UNION 拆为 FK/CHECK 两条独立单语句。
// N 前缀字符串：模板里原有的 N'MS_Description' 等保持原样，schema/表名等动态值用 sqlLiteral 普通字面量。
import type { DialectAdapter, TableRef } from './types'
import type { DbColumn, DbConstraint, DbIndex, DbTable } from './entities'
import { likePattern, num, nullableStr, sqlLiteral, str } from './shared'

const SYSTEM_SCHEMAS = "'sys','INFORMATION_SCHEMA'"

const schemaCondition = (column: string, schema: string | null): string =>
  schema ? `${column} = ${sqlLiteral(schema)}` : `${column} NOT IN (${SYSTEM_SCHEMAS})`

// MSSQL bit 列经驱动可能返回 0/1 数字、'0'/'1'/'true' 字符串或布尔，统一收敛为 JS 布尔。
const bool = (v: unknown): boolean => /^(1|true)$/i.test(String(v ?? ''))

export const mssqlAdapter: DialectAdapter = {
  dbType: 'mssql',
  // 源 get_tables：sys.tables + 扩展属性（minor_id = 0）作表注释。
  // 源模板的 LEFT JOIN INFORMATION_SCHEMA.TABLES 未引用任何列、不影响结果，移植时省去；
  // 注释缺省由源 ISNULL '-' 归一为 ''（与 mysql/postgres 适配器一致）；create/modify_date 不在实体内。
  listTables: (ref: TableRef) => `
    SELECT
      SCHEMA_NAME(a.schema_id) AS table_schema,
      a.name AS table_name,
      CONVERT(NVARCHAR(100), ISNULL(g.[value], '')) AS table_comment,
      '' AS engine,
      '' AS table_collation,
      (SELECT COUNT(*) FROM sys.columns cc WHERE cc.object_id = a.object_id) AS column_count
    FROM sys.tables a
    LEFT JOIN sys.extended_properties g
      ON a.object_id = g.major_id
     AND g.minor_id = 0
     AND g.name = N'MS_Description'
    WHERE ${schemaCondition('SCHEMA_NAME(a.schema_id)', ref.schema)}
    ORDER BY SCHEMA_NAME(a.schema_id), a.name`,
  // 聚合版列数统计（接口必需）：sys.tables 关联 sys.columns 按 schema/表名分组。
  countTableColumns: (ref: TableRef) => `
    SELECT SCHEMA_NAME(t.schema_id) AS table_schema, t.name AS table_name, COUNT(c.column_id) AS column_count
    FROM sys.tables t
    INNER JOIN sys.columns c ON c.object_id = t.object_id
    WHERE ${schemaCondition('SCHEMA_NAME(t.schema_id)', ref.schema)}
    GROUP BY SCHEMA_NAME(t.schema_id), t.name`,
  // 源 get_columns：完整保留 COLUMN_TYPE 的 CASE 拼接（binary/char 系列 (max) 与长度、
  // datetime2/datetimeoffset 精度、decimal/numeric 双参）、COLUMN_KEY 主键 EXISTS 子查询、
  // identity_columns/computed_columns 关联与 OBJECT_ID(QUOTENAME(...)) 定位。
  // 连接未选默认库时枚举可选库（ONLINE 且非系统库）
  listDatabases: () => `
    SELECT name AS database_name
    FROM sys.databases
    WHERE state = 0 AND name NOT IN ('master', 'model', 'msdb', 'tempdb')
    ORDER BY name`,
  listColumns: (ref: TableRef, table: string) => `
    SELECT
      c.TABLE_SCHEMA AS table_schema,
      c.TABLE_NAME AS table_name,
      c.COLUMN_NAME AS column_name,
      NULL AS extra,
      g.value AS column_comment,
      c.DATA_TYPE + ISNULL(
          CASE
              WHEN c.DATA_TYPE IN (N'binary', N'varbinary') THEN
                  (CASE c.CHARACTER_OCTET_LENGTH WHEN -1 THEN N'(max)' ELSE CONCAT(N'(', c.CHARACTER_OCTET_LENGTH, N')') END)
              WHEN c.DATA_TYPE IN (N'char', N'varchar', N'nchar', N'nvarchar') THEN
                  (CASE c.CHARACTER_MAXIMUM_LENGTH WHEN -1 THEN N'(max)' ELSE CONCAT(N'(', c.CHARACTER_MAXIMUM_LENGTH, N')') END)
              WHEN c.DATA_TYPE IN (N'datetime2', N'datetimeoffset') THEN CONCAT(N'(', c.DATETIME_PRECISION, N')')
              WHEN c.DATA_TYPE IN (N'decimal', N'numeric') THEN CONCAT(N'(', c.NUMERIC_PRECISION, N',', c.NUMERIC_SCALE, N')')
          END, ''
      ) AS column_type,
      c.DATA_TYPE AS data_type,
      c.COLUMN_DEFAULT AS column_default,
      CASE WHEN EXISTS (
          SELECT 1
          FROM sys.index_columns pic
          INNER JOIN sys.indexes pi
            ON pi.object_id = pic.object_id
           AND pi.index_id = pic.index_id
           AND pi.is_primary_key = 1
          WHERE pic.object_id = a.object_id
            AND pic.column_id = a.column_id
      ) THEN 'PRI' ELSE '' END AS column_key,
      c.IS_NULLABLE AS is_nullable,
      c.ordinal_position AS ordinal_position,
      ISNULL(c.CHARACTER_MAXIMUM_LENGTH, ISNULL(c.NUMERIC_PRECISION, '')) AS length,
      c.NUMERIC_SCALE AS scale,
      c.CHARACTER_SET_NAME AS character_set_name,
      a.collation_name AS collation_name,
      CASE WHEN idc.column_id IS NULL THEN 0 ELSE 1 END AS is_identity,
      idc.seed_value AS identity_seed,
      idc.increment_value AS identity_increment,
      a.is_computed AS is_computed,
      comp.definition AS generation_expression,
      comp.is_persisted AS is_persisted
    FROM INFORMATION_SCHEMA.COLUMNS c
    LEFT JOIN sys.columns a
      ON a.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + N'.' + QUOTENAME(c.TABLE_NAME))
     AND c.COLUMN_NAME = a.name
    LEFT JOIN sys.extended_properties g
      ON g.class = 1
     AND a.object_id = g.major_id
     AND a.column_id = g.minor_id
     AND g.name = N'MS_Description'
    LEFT JOIN sys.identity_columns idc ON a.object_id = idc.object_id AND a.column_id = idc.column_id
    LEFT JOIN sys.computed_columns comp ON a.object_id = comp.object_id AND a.column_id = comp.column_id
    WHERE ${schemaCondition('c.TABLE_SCHEMA', ref.schema)} AND c.TABLE_NAME = ${sqlLiteral(table)}
    ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
  // 源 get_indexes：type > 0 排除堆，type_desc、is_descending_key（mapIndex 转 ASC/DESC）、
  // is_included_column、filter_definition、扩展属性（class = 7，major/minor = object/index id）。
  listIndexes: (ref: TableRef, table: string) => `
    SELECT
      SCHEMA_NAME(t.schema_id) AS table_schema,
      t.name AS table_name,
      c.name AS column_name,
      ic.key_ordinal AS seq,
      i.name AS index_name,
      i.type_desc AS index_type,
      ISNULL(ep.value, '') AS index_comment,
      CASE WHEN i.is_unique = 1 THEN '0' ELSE '1' END AS non_unique,
      ic.is_descending_key AS is_descending_key,
      i.is_primary_key AS is_primary_key,
      i.is_unique_constraint AS is_unique_constraint,
      i.is_unique AS is_unique,
      ic.is_included_column AS is_included_column,
      ISNULL(i.filter_definition, '') AS predicate
    FROM sys.tables t
    INNER JOIN sys.indexes i ON t.object_id = i.object_id
    INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    LEFT JOIN sys.extended_properties ep
      ON ep.major_id = i.object_id
     AND ep.minor_id = i.index_id
     AND ep.class = 7
     AND ep.name = N'MS_Description'
    WHERE i.type > 0
      AND ${schemaCondition('SCHEMA_NAME(t.schema_id)', ref.schema)} AND t.name = ${sqlLiteral(table)}
    ORDER BY SCHEMA_NAME(t.schema_id), t.name, i.name, ic.key_ordinal`,
  // 源 get_constraints 的 FK 段：*_referential_action_desc 规则描述保留原样。
  listForeignKeys: (ref: TableRef, table: string) => `
    SELECT
      SCHEMA_NAME(parent_table.schema_id) AS table_schema,
      parent_table.name AS table_name,
      fk.name AS constraint_name,
      'FOREIGN KEY' AS constraint_type,
      parent_column.name AS column_name,
      fkc.constraint_column_id AS seq,
      SCHEMA_NAME(referenced_table.schema_id) AS referenced_schema,
      referenced_table.name AS referenced_table,
      referenced_column.name AS referenced_column,
      fk.update_referential_action_desc AS update_rule,
      fk.delete_referential_action_desc AS delete_rule,
      '' AS check_clause
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    INNER JOIN sys.tables parent_table ON parent_table.object_id = fk.parent_object_id
    INNER JOIN sys.columns parent_column
      ON parent_column.object_id = fkc.parent_object_id
     AND parent_column.column_id = fkc.parent_column_id
    INNER JOIN sys.tables referenced_table ON referenced_table.object_id = fk.referenced_object_id
    INNER JOIN sys.columns referenced_column
      ON referenced_column.object_id = fkc.referenced_object_id
     AND referenced_column.column_id = fkc.referenced_column_id
    WHERE ${schemaCondition('SCHEMA_NAME(parent_table.schema_id)', ref.schema)}
      AND parent_table.name = ${sqlLiteral(table)}
    ORDER BY table_schema, table_name, constraint_name, seq`,
  // 源 get_constraints 的 CHECK 段：definition 即检查表达式。
  listChecks: (ref: TableRef, table: string) => `
    SELECT
      SCHEMA_NAME(parent_table.schema_id) AS table_schema,
      parent_table.name AS table_name,
      cc.name AS constraint_name,
      'CHECK' AS constraint_type,
      '' AS column_name,
      0 AS seq,
      '' AS referenced_schema,
      '' AS referenced_table,
      '' AS referenced_column,
      '' AS update_rule,
      '' AS delete_rule,
      cc.definition AS check_clause
    FROM sys.check_constraints cc
    INNER JOIN sys.tables parent_table ON parent_table.object_id = cc.parent_object_id
    WHERE ${schemaCondition('SCHEMA_NAME(parent_table.schema_id)', ref.schema)}
      AND parent_table.name = ${sqlLiteral(table)}
    ORDER BY table_schema, table_name, constraint_name, seq`,
  // 字段搜索：列名/扩展属性注释 LIKE（MSSQL 无默认转义符，显式 ESCAPE '\' 使 likePattern 的通配符转义生效，
  // 与 mysql/pg 行为一致）。
  searchColumns: (ref: TableRef, keyword: string) => `
    SELECT DISTINCT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name,
      c.COLUMN_NAME AS column_name, ISNULL(CONVERT(NVARCHAR(MAX), g.value), '') AS column_comment
    FROM INFORMATION_SCHEMA.COLUMNS c
    LEFT JOIN sys.extended_properties g
      ON g.class = 1
     AND g.major_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + N'.' + QUOTENAME(c.TABLE_NAME))
     AND g.minor_id = c.ORDINAL_POSITION
     AND g.name = N'MS_Description'
    WHERE ${schemaCondition('c.TABLE_SCHEMA', ref.schema)}
      AND (c.COLUMN_NAME LIKE ${likePattern(keyword)} ESCAPE '\\'
        OR ISNULL(CONVERT(NVARCHAR(MAX), g.value), '') LIKE ${likePattern(keyword)} ESCAPE '\\')`,
  mapTable: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name), table_comment: str(row.table_comment),
    engine: str(row.engine), table_collation: str(row.table_collation), column_count: num(row.column_count) ?? 0
  }),
  mapColumn: (row) => {
    const isIdentity = bool(row.is_identity)
    const isComputed = bool(row.is_computed)
    const isPersisted = bool(row.is_persisted)
    return {
      table_schema: str(row.table_schema), table_name: str(row.table_name), column_name: str(row.column_name),
      extra: nullableStr(row.extra), column_default: nullableStr(row.column_default), column_comment: str(row.column_comment),
      column_type: str(row.column_type), data_type: str(row.data_type), column_key: str(row.column_key),
      is_nullable: str(row.is_nullable), ordinal_position: num(row.ordinal_position),
      length: num(row.length), scale: num(row.scale),
      character_set_name: nullableStr(row.character_set_name), collation_name: nullableStr(row.collation_name),
      default_is_expression: false,
      generation_expression: nullableStr(row.generation_expression),
      generated_storage: isComputed ? (isPersisted ? 'STORED' : 'VIRTUAL') : null,
      is_identity: isIdentity,
      identity_generation: isIdentity ? 'IDENTITY' : null,
      // IDENTITY(seed, increment)：seed 即起始值，identity_start 与 identity_seed 同源（数字→字符串）。
      identity_start: nullableStr(row.identity_seed), identity_seed: nullableStr(row.identity_seed),
      identity_increment: nullableStr(row.identity_increment),
      is_computed: isComputed, is_persisted: isPersisted
    }
  },
  mapIndex: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name),
    column_name: str(row.column_name),
    seq: num(row.seq) ?? 0, index_name: str(row.index_name), index_type: str(row.index_type),
    index_comment: str(row.index_comment), non_unique: str(row.non_unique),
    collation: bool(row.is_descending_key) ? 'DESC' : 'ASC',
    is_primary: bool(row.is_primary_key), is_unique: bool(row.is_unique),
    is_unique_constraint: bool(row.is_unique_constraint), is_included: bool(row.is_included_column),
    is_expression: false, predicate: str(row.predicate),
    constraint_type: '', sub_part: null, expression: ''
  }),
  mapConstraint: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name),
    constraint_name: str(row.constraint_name), constraint_type: str(row.constraint_type),
    column_name: str(row.column_name), seq: num(row.seq) ?? 0,
    referenced_schema: str(row.referenced_schema), referenced_table: str(row.referenced_table),
    referenced_column: str(row.referenced_column), update_rule: str(row.update_rule), delete_rule: str(row.delete_rule),
    check_clause: str(row.check_clause)
  })
}
