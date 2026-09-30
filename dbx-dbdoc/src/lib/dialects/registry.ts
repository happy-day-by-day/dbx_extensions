import type { DialectAdapter } from './types'
import { mysqlAdapter } from './mysql'
import { postgresAdapter } from './postgres'
import { mssqlAdapter } from './mssql'

const ALIASES: Record<string, 'mysql' | 'postgres' | 'mssql'> = {
  mysql: 'mysql', mariadb: 'mysql',
  postgres: 'postgres', postgresql: 'postgres', pg: 'postgres',
  mssql: 'mssql', sqlserver: 'mssql', 'sql-server': 'mssql', azure: 'mssql'
}

export function normalizeDbType(dbType: string): 'mysql' | 'postgres' | 'mssql' | 'unknown' {
  return ALIASES[String(dbType || '').trim().toLowerCase()] ?? 'unknown'
}

export function getAdapter(dbType: string): DialectAdapter | null {
  const normalized = normalizeDbType(dbType)
  if (normalized === 'unknown') return null
  return { mysql: mysqlAdapter, postgres: postgresAdapter, mssql: mssqlAdapter }[normalized]
}
