import { describe, expect, it } from 'vitest'
import { createTableSelectSql } from './tableQuery'

describe('table query SQL', () => {
  it.each([
    ['mysql', 'shop', 'order', 'SELECT * FROM `shop`.`order`;'],
    ['mariadb', 'shop', 'table`name', 'SELECT * FROM `shop`.`table``name`;'],
    ['postgresql', 'sales', 'order', 'SELECT * FROM "sales"."order";'],
    ['postgres', 'schema"name', 'table"name', 'SELECT * FROM "schema""name"."table""name";'],
    ['sqlserver', 'dbo', 'order', 'SELECT * FROM [dbo].[order];'],
    ['mssql', 'a]b', 'c]d', 'SELECT * FROM [a]]b].[c]]d];'],
    ['postgres', 'sales', 'table.with.dot', 'SELECT * FROM "sales"."table.with.dot";'],
    ['mysql', 'shop', 'table; DROP TABLE users; --', 'SELECT * FROM `shop`.`table; DROP TABLE users; --`;'],
    ['postgres', '业务库', ' 订单 ', 'SELECT * FROM "业务库"." 订单 ";']
  ])('quotes %s identity %s.%s', (dbType, schema, table, expected) => {
    expect(createTableSelectSql({ dbType, schema, table })).toBe(expected)
  })
  it('qualifies MySQL by the selected database when schema is absent', () => {
    expect(createTableSelectSql({ dbType: 'mysql', database: 'selected', table: 'orders' })).toBe('SELECT * FROM `selected`.`orders`;')
  })
  it('keeps PostgreSQL database separate from its schema', () => {
    expect(createTableSelectSql({ dbType: 'postgres', database: 'appdb', table: 'orders' })).toBe('SELECT * FROM "orders";')
  })
  it('rejects missing table and unsupported dialect instead of guessing', () => {
    expect(() => createTableSelectSql({ dbType: 'mysql', table: ' ' })).toThrow('缺少查询表名')
    expect(() => createTableSelectSql({ dbType: 'oracle', table: 'orders' })).toThrow('暂不支持')
  })
})
