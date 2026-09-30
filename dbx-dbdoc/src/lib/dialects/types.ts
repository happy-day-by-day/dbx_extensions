import type { DbColumn, DbConstraint, DbIndex, DbTable } from './entities'

export interface TableRef { db: string | null; schema: string | null; table: string | null }
export interface DialectAdapter {
  readonly dbType: 'mysql' | 'postgres' | 'mssql'
  listTables(ref: TableRef): string
  countTableColumns(ref: TableRef): string
  // 连接未指定默认库时枚举可选库（postgres 跨库路由不可行，不实现）
  listDatabases?(ref: TableRef): string
  listColumns(ref: TableRef, table: string): string
  listIndexes(ref: TableRef, table: string): string
  listIndexesLegacy?(ref: TableRef, table: string): string
  listForeignKeys(ref: TableRef, table: string): string
  // 返回一行 available（0/1），用于兼容没有检查约束系统表的数据库版本。
  probeCheckConstraints?(): string
  listChecks(ref: TableRef, table: string): string
  searchColumns(ref: TableRef, keyword: string): string
  mapTable(row: Record<string, unknown>): DbTable
  mapColumn(row: Record<string, unknown>): DbColumn
  mapIndex(row: Record<string, unknown>): DbIndex
  mapConstraint(row: Record<string, unknown>): DbConstraint
}
