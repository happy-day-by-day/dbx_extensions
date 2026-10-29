import { describe, expect, it } from 'vitest'
import { databaseDocumentTitle } from './workbenchTitle'

describe('database document title', () => {
  it('uses the actual database name even when a table is selected', () => {
    expect(databaseDocumentTitle({ database: 'Health_MySQL_2026_TEST', name: '业务连接', table: 'orders' }))
      .toBe('Health_MySQL_2026_TEST-数据库文档')
    expect(databaseDocumentTitle({ database: '0f9e8d7c6b5a4321', table: 'users' }))
      .toBe('0f9e8d7c6b5a4321-数据库文档')
  })

  it('falls back to a known connection name or a generic title when no database is selected', () => {
    expect(databaseDocumentTitle({ connectionId: 'c1', name: '业务连接' })).toBe('业务连接-数据库文档')
    expect(databaseDocumentTitle({ connectionId: 'c1', name: 'c1' })).toBe('数据库文档')
    expect(databaseDocumentTitle({ name: 'orders', table: 'orders' })).toBe('数据库文档')
    expect(databaseDocumentTitle({ database: '  ' })).toBe('数据库文档')
    expect(databaseDocumentTitle({})).toBe('数据库文档')
  })
})
