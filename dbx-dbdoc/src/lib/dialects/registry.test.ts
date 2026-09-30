import { describe, expect, it } from 'vitest'
import { getAdapter, normalizeDbType } from './registry'

describe('registry', () => {
  it('归一化数据库类型', () => {
    expect(normalizeDbType('mysql')).toBe('mysql')
    expect(normalizeDbType('MariaDB')).toBe('mysql')
    expect(normalizeDbType('postgres')).toBe('postgres')
    expect(normalizeDbType('PostgreSQL')).toBe('postgres')
    expect(normalizeDbType('mssql')).toBe('mssql')
    expect(normalizeDbType('sqlserver')).toBe('mssql')
    expect(normalizeDbType('oracle')).toBe('unknown')
  })
  it('getAdapter 未适配类型返回 null', () => {
    expect(getAdapter('mysql')).not.toBeNull()
    expect(getAdapter('oracle')).toBeNull()
  })
})
