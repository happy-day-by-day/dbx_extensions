// PostgreSQL 方言适配器：移植自 data-watcher apps/dbdoc/infrastructure/databases/postgresql.py。
// 移植规则：驱动占位符（%s/%%）改为 sqlLiteral 字面量拼接；= ANY(schemas) 数组参数改为
// schema 等值过滤（无值时排除系统 schema）；约束 UNION 拆为 FK/CHECK 两条独立单语句。
import type { DialectAdapter, TableRef } from './types'
import type { DbColumn, DbConstraint, DbIndex, DbTable } from './entities'
import { likePattern, num, nullableStr, sqlLiteral, str } from './shared'

const SYSTEM_SCHEMAS = "'pg_catalog', 'information_schema'"

const schemaCondition = (column: string, schema: string | null): string =>
  schema ? `${column} = ${sqlLiteral(schema)}` : `${column} NOT IN (${SYSTEM_SCHEMAS})`

// pg 驱动的布尔列可能返回 bool 或 't'/'f' 字符串，统一收敛为 JS 布尔。
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'T' || v === 1 || v === '1'

export const postgresAdapter: DialectAdapter = {
  dbType: 'postgres',
  // 源 get_tables：始终排除系统 schema，指定 schema 时再叠加等值过滤（对应源的 NOT IN + = ANY 组合）。
  listTables: (ref: TableRef) => `
    SELECT table_schema AS table_schema, table_name AS table_name,
           COALESCE(obj_description(format('%I.%I', table_schema, table_name)::regclass), '') AS table_comment,
           '' AS engine, '' AS table_collation,
           (SELECT count(*) FROM information_schema.columns cc
             WHERE cc.table_schema = t.table_schema AND cc.table_name = t.table_name) AS column_count
    FROM information_schema.tables t
    WHERE table_schema NOT IN (${SYSTEM_SCHEMAS})
      ${ref.schema ? `AND ${schemaCondition('table_schema', ref.schema)}` : ''}
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name`,
  countTableColumns: (ref: TableRef) => `
    SELECT table_schema AS table_schema, table_name AS table_name, count(*) AS column_count
    FROM information_schema.columns
    WHERE ${schemaCondition('table_schema', ref.schema)}
    GROUP BY table_schema, table_name`,
  // 源 get_columns：保留 pg_namespace/pg_class/pg_attribute 关联与全部 20 列，extra 由 CASE 生成。
  listColumns: (ref: TableRef, table: string) => `
    SELECT
      c.table_schema AS table_schema,
      c.table_name AS table_name,
      c.column_name AS column_name,
      CASE
        WHEN c.is_identity = 'YES' THEN 'IDENTITY'
        WHEN c.is_generated = 'ALWAYS' THEN 'GENERATED'
        ELSE NULL
      END AS extra,
      COALESCE(col_description(rel.oid, attr.attnum), '') AS column_comment,
      format_type(attr.atttypid, attr.atttypmod) AS column_type,
      c.data_type AS data_type,
      c.column_default AS column_default,
      CASE WHEN c.is_nullable = 'YES' THEN 'YES' ELSE 'NO' END AS is_nullable,
      c.ordinal_position AS ordinal_position,
      c.character_maximum_length AS character_maximum_length,
      c.numeric_precision AS numeric_precision,
      c.numeric_scale AS scale,
      c.character_set_name AS character_set_name,
      c.collation_name AS collation_name,
      c.is_identity AS is_identity,
      c.identity_generation AS identity_generation,
      c.identity_start AS identity_start,
      c.identity_increment AS identity_increment,
      c.is_generated AS is_generated,
      c.generation_expression AS generation_expression
    FROM information_schema.columns AS c
    INNER JOIN pg_namespace AS ns ON ns.nspname = c.table_schema
    INNER JOIN pg_class AS rel ON rel.relnamespace = ns.oid AND rel.relname = c.table_name
    INNER JOIN pg_attribute AS attr
      ON attr.attrelid = rel.oid
     AND attr.attname = c.column_name
     AND attr.attnum > 0
     AND NOT attr.attisdropped
    WHERE ${schemaCondition('c.table_schema', ref.schema)} AND c.table_name = ${sqlLiteral(table)}
    ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  // 源 get_indexes：保留 indkey LATERAL 展开、indoption 方向判定、indnkeyatts INCLUDE、indpred 谓词。
  listIndexes: (ref: TableRef, table: string) => `
    SELECT
      ns.nspname AS table_schema,
      rel.relname AS table_name,
      COALESCE(att.attname, pg_get_indexdef(idx.indexrelid, arr.ord::integer, true)) AS column_name,
      arr.ord AS seq,
      idx_rel.relname AS index_name,
      am.amname AS index_type,
      COALESCE(obj_description(idx_rel.oid, 'pg_class'), '') AS index_comment,
      CASE WHEN idx.indisunique THEN '0' ELSE '1' END AS non_unique,
      CASE WHEN (idx.indoption[arr.ord - 1] & 1) = 1 THEN 'DESC' ELSE 'ASC' END AS collation,
      idx.indisprimary AS is_primary,
      idx.indisunique AS is_unique,
      arr.ord > idx.indnkeyatts AS is_included,
      att.attname IS NULL AS is_expression,
      COALESCE(pg_get_expr(idx.indpred, idx.indrelid), '') AS predicate,
      COALESCE(con.contype::text, '') AS constraint_type,
      NULL AS sub_part
    FROM pg_class AS rel
    JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
    JOIN pg_index AS idx ON rel.oid = idx.indrelid
    JOIN pg_class AS idx_rel ON idx.indexrelid = idx_rel.oid
    JOIN pg_am AS am ON idx_rel.relam = am.oid
    CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS arr(attnum, ord)
    LEFT JOIN pg_attribute AS att ON att.attrelid = idx.indrelid AND att.attnum = arr.attnum
    LEFT JOIN pg_constraint AS con
      ON con.conindid = idx.indexrelid
     AND con.contype IN ('p', 'u', 'x')
    WHERE rel.relkind IN ('r', 'p')
      AND ${schemaCondition('ns.nspname', ref.schema)} AND rel.relname = ${sqlLiteral(table)}
    ORDER BY ns.nspname, rel.relname, idx_rel.relname, arr.ord`,
  // 源 get_constraints 的 FK 段：confupdtype/confdeltype CASE 映射保留，叠加表名过滤。
  listForeignKeys: (ref: TableRef, table: string) => `
    SELECT
      ns.nspname AS table_schema,
      rel.relname AS table_name,
      con.conname AS constraint_name,
      'FOREIGN KEY' AS constraint_type,
      att.attname AS column_name,
      keys.ord AS seq,
      ref_ns.nspname AS referenced_schema,
      ref_rel.relname AS referenced_table,
      ref_att.attname AS referenced_column,
      CASE con.confupdtype
        WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE ''
      END AS update_rule,
      CASE con.confdeltype
        WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE ''
      END AS delete_rule,
      '' AS check_clause
    FROM pg_constraint AS con
    INNER JOIN pg_class AS rel ON rel.oid = con.conrelid
    INNER JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
    INNER JOIN pg_class AS ref_rel ON ref_rel.oid = con.confrelid
    INNER JOIN pg_namespace AS ref_ns ON ref_ns.oid = ref_rel.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ord)
    INNER JOIN pg_attribute AS att ON att.attrelid = con.conrelid AND att.attnum = keys.attnum
    INNER JOIN pg_attribute AS ref_att
      ON ref_att.attrelid = con.confrelid
     AND ref_att.attnum = con.confkey[keys.ord::integer]
    WHERE con.contype = 'f'
      AND ${schemaCondition('ns.nspname', ref.schema)} AND rel.relname = ${sqlLiteral(table)}
    ORDER BY table_schema, table_name, constraint_name, seq`,
  // 源 get_constraints 的 CHECK 段：conbin 表达式经 pg_get_expr 还原。
  listChecks: (ref: TableRef, table: string) => `
    SELECT
      ns.nspname AS table_schema,
      rel.relname AS table_name,
      con.conname AS constraint_name,
      'CHECK' AS constraint_type,
      '' AS column_name,
      0 AS seq,
      '' AS referenced_schema,
      '' AS referenced_table,
      '' AS referenced_column,
      '' AS update_rule,
      '' AS delete_rule,
      pg_get_expr(con.conbin, con.conrelid) AS check_clause
    FROM pg_constraint AS con
    INNER JOIN pg_class AS rel ON rel.oid = con.conrelid
    INNER JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
    WHERE con.contype = 'c'
      AND ${schemaCondition('ns.nspname', ref.schema)} AND rel.relname = ${sqlLiteral(table)}
    ORDER BY table_schema, table_name, constraint_name, seq`,
  searchColumns: (ref: TableRef, keyword: string) => `
    SELECT DISTINCT c.table_schema AS table_schema, c.table_name AS table_name
    FROM information_schema.columns AS c
    JOIN pg_namespace AS ns ON ns.nspname = c.table_schema
    JOIN pg_class AS rel ON rel.relnamespace = ns.oid AND rel.relname = c.table_name
    WHERE ${schemaCondition('c.table_schema', ref.schema)}
      AND (c.column_name ILIKE ${likePattern(keyword)}
        OR COALESCE(col_description(rel.oid, c.ordinal_position::int), '') ILIKE ${likePattern(keyword)})`,
  mapTable: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name), table_comment: str(row.table_comment),
    engine: str(row.engine), table_collation: str(row.table_collation), column_count: num(row.column_count) ?? 0
  }),
  mapColumn: (row) => {
    const isIdentity = String(row.is_identity ?? '').toUpperCase() === 'YES'
    const isGenerated = String(row.is_generated ?? '').toUpperCase() === 'ALWAYS'
    return {
      table_schema: str(row.table_schema), table_name: str(row.table_name), column_name: str(row.column_name),
      extra: nullableStr(row.extra), column_default: nullableStr(row.column_default), column_comment: str(row.column_comment),
      column_type: str(row.column_type), data_type: str(row.data_type), column_key: '',
      is_nullable: str(row.is_nullable), ordinal_position: num(row.ordinal_position),
      length: num(row.length ?? row.character_maximum_length ?? row.numeric_precision), scale: num(row.scale),
      character_set_name: nullableStr(row.character_set_name), collation_name: nullableStr(row.collation_name),
      default_is_expression: false,
      generation_expression: isGenerated ? nullableStr(row.generation_expression) : null,
      generated_storage: isGenerated ? 'STORED' : null,
      is_identity: isIdentity,
      identity_generation: nullableStr(row.identity_generation),
      identity_start: nullableStr(row.identity_start), identity_increment: nullableStr(row.identity_increment),
      is_computed: isGenerated, is_persisted: isGenerated, identity_seed: null
    }
  },
  mapIndex: (row) => {
    const columnName = str(row.column_name ?? '')
    const isExpression = bool(row.is_expression)
    const constraintType = str(row.constraint_type)
    return {
      table_schema: str(row.table_schema), table_name: str(row.table_name),
      column_name: columnName,
      seq: num(row.seq) ?? 0, index_name: str(row.index_name), index_type: str(row.index_type),
      index_comment: str(row.index_comment), non_unique: str(row.non_unique), collation: str(row.collation),
      is_primary: bool(row.is_primary), is_unique: bool(row.is_unique),
      is_unique_constraint: constraintType === 'u', is_included: bool(row.is_included),
      is_expression: isExpression, predicate: str(row.predicate),
      constraint_type: constraintType, sub_part: num(row.sub_part),
      expression: isExpression ? columnName : ''
    }
  },
  mapConstraint: (row) => ({
    table_schema: str(row.table_schema), table_name: str(row.table_name),
    constraint_name: str(row.constraint_name), constraint_type: str(row.constraint_type),
    column_name: str(row.column_name), seq: num(row.seq) ?? 0,
    referenced_schema: str(row.referenced_schema), referenced_table: str(row.referenced_table),
    referenced_column: str(row.referenced_column), update_rule: str(row.update_rule), delete_rule: str(row.delete_rule),
    check_clause: str(row.check_clause)
  })
}
