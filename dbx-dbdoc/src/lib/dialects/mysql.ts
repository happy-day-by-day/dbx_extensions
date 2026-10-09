import type { DialectAdapter, TableRef } from './types'
import type { DbColumn, DbConstraint, DbIndex, DbTable } from './entities'
import { likePattern, num, nullableStr, sqlLiteral, str } from './shared'

const SYSTEM_SCHEMAS = "'INFORMATION_SCHEMA','MYSQL','PERFORMANCE_SCHEMA','SYS'"

const dbFilter = (db: string | null, alias = ''): string => {
  const schema = `${alias ? `${alias}.` : ''}TABLE_SCHEMA`
  return db ? `${schema} = ${sqlLiteral(db)}` : `${schema} = DATABASE() AND ${schema} NOT IN (${SYSTEM_SCHEMAS})`
}

const tableFilter = (db: string | null, table: string): string =>
  `${dbFilter(db)} AND TABLE_NAME = ${sqlLiteral(table)}`

// 多表联查（kcu JOIN tc/rc）不能复用 tableFilter：三表都有 TABLE_SCHEMA/TABLE_NAME，
// 未限定列名会触发 MySQL ERROR 1052（歧义列），改用别名限定的等值过滤。
// db 为空时 DATABASE() 即当前库（不可能是系统库），无需 NOT IN 排除。
const qualifiedTableFilter = (alias: string, db: string | null, table: string): string =>
  `${alias}.TABLE_SCHEMA = ${db ? sqlLiteral(db) : 'DATABASE()'} AND ${alias}.TABLE_NAME = ${sqlLiteral(table)}`

export const mysqlAdapter: DialectAdapter = {
  dbType: 'mysql',
  listTables: (ref) => `
    SELECT t.TABLE_SCHEMA AS table_schema, t.TABLE_NAME AS table_name,
           IFNULL(t.TABLE_COMMENT, '') AS table_comment,
           IFNULL(t.ENGINE, '') AS engine, IFNULL(t.TABLE_COLLATION, '') AS table_collation,
           IFNULL(c.column_count, 0) AS column_count
    FROM INFORMATION_SCHEMA.TABLES t
    LEFT JOIN (
      SELECT TABLE_SCHEMA, TABLE_NAME, COUNT(*) AS column_count
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE ${dbFilter(ref.db)}
      GROUP BY TABLE_SCHEMA, TABLE_NAME
    ) c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
    WHERE t.TABLE_TYPE = 'BASE TABLE' AND ${dbFilter(ref.db, 't')}
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`,
  countTableColumns: (ref) => `
    SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COUNT(*) AS column_count
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE ${dbFilter(ref.db)}
    GROUP BY TABLE_SCHEMA, TABLE_NAME`,
  // 连接未选默认库时枚举可选库（排除系统库）
  listDatabases: () => `
    SELECT SCHEMA_NAME AS database_name
    FROM INFORMATION_SCHEMA.SCHEMATA
    WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
    ORDER BY SCHEMA_NAME`,
  listColumns: (ref, table) => `
    SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, EXTRA AS extra,
           IFNULL(COLUMN_COMMENT, '') AS column_comment, COLUMN_TYPE AS column_type, DATA_TYPE AS data_type,
           COLUMN_DEFAULT AS column_default, COLUMN_KEY AS column_key, IS_NULLABLE AS is_nullable,
           IFNULL(CHARACTER_MAXIMUM_LENGTH, IFNULL(NUMERIC_PRECISION, IFNULL(DATETIME_PRECISION, NULL))) AS length,
           NUMERIC_SCALE AS scale, ORDINAL_POSITION AS ordinal_position,
           CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name,
           GENERATION_EXPRESSION AS generation_expression
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE ${tableFilter(ref.db, table)}
    ORDER BY ORDINAL_POSITION`,
  listIndexes: (ref, table) => `
    SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
           SEQ_IN_INDEX AS seq, INDEX_NAME AS index_name, INDEX_TYPE AS index_type,
           IFNULL(INDEX_COMMENT, '') AS index_comment, NON_UNIQUE AS non_unique, COLLATION AS collation,
           SUB_PART AS sub_part, EXPRESSION AS expression
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE ${tableFilter(ref.db, table)}
    ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
  listIndexesLegacy: (ref, table) => `
    SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
           SEQ_IN_INDEX AS seq, INDEX_NAME AS index_name, INDEX_TYPE AS index_type,
           IFNULL(INDEX_COMMENT, '') AS index_comment, NON_UNIQUE AS non_unique, COLLATION AS collation,
           SUB_PART AS sub_part, NULL AS expression
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE ${tableFilter(ref.db, table)}
    ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
  listForeignKeys: (ref, table) => `
    SELECT kcu.TABLE_SCHEMA AS table_schema, kcu.TABLE_NAME AS table_name, kcu.CONSTRAINT_NAME AS constraint_name,
           kcu.COLUMN_NAME AS column_name, kcu.ORDINAL_POSITION AS seq,
           kcu.REFERENCED_TABLE_SCHEMA AS referenced_schema, kcu.REFERENCED_TABLE_NAME AS referenced_table,
           kcu.REFERENCED_COLUMN_NAME AS referenced_column,
           IFNULL(rc.UPDATE_RULE, '') AS update_rule, IFNULL(rc.DELETE_RULE, '') AS delete_rule
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND tc.TABLE_NAME = kcu.TABLE_NAME
     AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
    LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.TABLE_NAME = kcu.TABLE_NAME
     AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
    WHERE ${qualifiedTableFilter('kcu', ref.db, table)}
    ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
  probeCheckConstraints: () => `
    SELECT COUNT(*) AS available
    FROM INFORMATION_SCHEMA.TABLES
    WHERE UPPER(TABLE_SCHEMA) = 'INFORMATION_SCHEMA'
      AND UPPER(TABLE_NAME) = 'CHECK_CONSTRAINTS'`,
  listChecks: (ref, table) => `
    SELECT tc.TABLE_SCHEMA AS table_schema, tc.TABLE_NAME AS table_name, tc.CONSTRAINT_NAME AS constraint_name,
           cc.CHECK_CLAUSE AS check_clause
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    WHERE tc.CONSTRAINT_TYPE = 'CHECK' AND ${qualifiedTableFilter('tc', ref.db, table)}
    ORDER BY tc.CONSTRAINT_NAME`,
  searchColumns: (ref, keyword) => `
    SELECT DISTINCT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
      COLUMN_NAME AS column_name, COLUMN_COMMENT AS column_comment
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE ${dbFilter(ref.db)} AND (COLUMN_NAME LIKE ${likePattern(keyword)} OR COLUMN_COMMENT LIKE ${likePattern(keyword)})`,
  mapTable: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name), table_comment: str(row.table_comment),
    engine: str(row.engine), table_collation: str(row.table_collation), column_count: num(row.column_count) ?? 0
  }),
  mapColumn: (row) => {
    const extra = nullableStr(row.extra)
    const upper = String(extra ?? '').toUpperCase()
    return {
      table_schema: str(row.table_schema), table_name: str(row.table_name), column_name: str(row.column_name),
      extra, column_default: nullableStr(row.column_default), column_comment: str(row.column_comment),
      column_type: str(row.column_type), data_type: str(row.data_type), column_key: str(row.column_key),
      is_nullable: str(row.is_nullable), ordinal_position: num(row.ordinal_position),
      length: num(row.length), scale: num(row.scale),
      character_set_name: nullableStr(row.character_set_name), collation_name: nullableStr(row.collation_name),
      default_is_expression: upper.includes('DEFAULT_GENERATED'),
      generation_expression: nullableStr(row.generation_expression),
      generated_storage: upper.includes('STORED GENERATED') ? 'STORED' : upper.includes('VIRTUAL GENERATED') ? 'VIRTUAL' : null,
      is_identity: false, identity_generation: null, identity_start: null, identity_increment: null,
      is_computed: false, is_persisted: false, identity_seed: null
    }
  },
  mapIndex: (row) => {
    const indexName = str(row.index_name)
    const nonUnique = row.non_unique == null ? '1' : String(row.non_unique)
    const expression = str(row.expression ?? '')
    return {
      table_schema: str(row.table_schema), table_name: str(row.table_name),
      column_name: str(row.column_name ?? '') || expression,
      seq: num(row.seq) ?? 1, index_name: indexName, index_type: str(row.index_type),
      index_comment: str(row.index_comment), non_unique: nonUnique, collation: str(row.collation),
      is_primary: indexName.toUpperCase() === 'PRIMARY',
      is_unique: nonUnique === '0',
      is_unique_constraint: false, is_included: false,
      is_expression: Boolean(expression), predicate: '',
      constraint_type: '', sub_part: num(row.sub_part), expression
    }
  },
  mapConstraint: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name),
    constraint_name: str(row.constraint_name), constraint_type: str(row.constraint_type ?? 'FOREIGN KEY'),
    column_name: str(row.column_name), seq: num(row.seq) ?? 0,
    referenced_schema: str(row.referenced_schema), referenced_table: str(row.referenced_table),
    referenced_column: str(row.referenced_column), update_rule: str(row.update_rule), delete_rule: str(row.delete_rule),
    check_clause: str(row.check_clause)
  })
}
