import type { PluginContext } from './types'
import { normalizeDbType } from './dialects/registry'

export const TABLE_QUERY_WORKBENCH_ID = 'com.sazs.dbdoc.query'
export const TABLE_QUERY_MAX_ROWS = 200

/** Quote complete identifiers, including reserved words, dots and embedded delimiters. */
export function createTableSelectSql(context: PluginContext): string {
  if (!context.table?.trim()) throw new Error('缺少查询表名')
  const type = normalizeDbType(context.dbType ?? '')
  if (type === 'unknown') throw new Error('暂不支持该数据库类型的表查询')
  const quote = type === 'mysql' ? (value: string) => '`' + value.replace(/`/g, '``') + '`'
    : type === 'mssql' ? (value: string) => '[' + value.replace(/]/g, ']]') + ']'
      : (value: string) => '"' + value.replace(/"/g, '""') + '"'
  const schema = context.schema || (type === 'mysql' ? context.database : undefined)
  return `SELECT * FROM ${schema ? quote(schema) + '.' : ''}${quote(context.table)};`
}
