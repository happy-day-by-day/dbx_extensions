import { describe, expect, it } from 'vitest'
import { likePattern, rowsToObjects, sqlLiteral } from './shared'

describe('shared', () => {
  it('sqlLiteral 转义单引号', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'")
    expect(sqlLiteral('')).toBe("''")
    expect(sqlLiteral('plain')).toBe("'plain'")
  })
  it('likePattern 转义 % _ 与反斜杠', () => {
    expect(likePattern('a%b_c\\d')).toBe("'%a\\%b\\_c\\\\d%'")
    expect(likePattern('')).toBe("'%%'")
  })
  it('rowsToObjects 按列名映射行数据', () => {
    const result = { columns: [{ name: 'id' }, { name: 'name' }], rows: [[1, 'a'], [2, 'b']] }
    expect(rowsToObjects(result)).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' }
    ])
  })
  it('字段搜索关键字含单引号时仍形成合法 SQL 字面量', () => {
    expect(likePattern("O'Reilly")).toBe("'%O''Reilly%'")
  })
})
