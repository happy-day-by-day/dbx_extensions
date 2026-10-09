import { describe, expect, it } from 'vitest'
import { columnMatchPreview, groupColumnMatches, matchingExcerpt, tableSearchKey } from './columnSearch'

describe('字段搜索摘要', () => {
  it('跨 Schema 同名表及带点的标识符不混合，重复字段只保留一次', () => {
    const groups = groupColumnMatches([
      { table_schema: 'public', table_name: 'orders', column_name: 'user_id', column_comment: '下单用户' },
      { table_schema: 'public', table_name: 'orders', column_name: 'user_id', column_comment: '下单用户' },
      { table_schema: 'sales', table_name: 'orders', column_name: 'buyer_id', column_comment: null },
      { table_schema: 'a.b', table_name: 'c', column_name: 'id' },
      { table_schema: 'a', table_name: 'b.c', column_name: 'code' },
      { table_name: 'invalid' }
    ])
    expect(groups.size).toBe(4)
    expect(groups.get(tableSearchKey('public', 'orders'))).toEqual([{ name: 'user_id', comment: '下单用户' }])
    expect(groups.get(tableSearchKey('sales', 'orders'))).toEqual([{ name: 'buyer_id', comment: '' }])
  })
  it('长字段注释摘要保留命中附近的文本，优先显示注释命中', () => {
    const match = { name: 'buyer_id', comment: '前置说明'.repeat(20) + '采购人' + '后置说明'.repeat(20) }
    const preview = columnMatchPreview(match, '采购人')
    expect(preview.startsWith('…')).toBe(true)
    expect(preview).toContain('采购人')
    expect(preview.endsWith(' · buyer_id')).toBe(true)
    expect(preview.length).toBeLessThan(60)
  })
  it('字段名按字面量匹配，保留大小写与中文原文', () => {
    expect(columnMatchPreview({ name: 'USER_ID', comment: '用户编号' }, 'user_id')).toBe('USER_ID · 用户编号')
    expect(matchingExcerpt('a[b]c', '[b]')).toBe('a[b]c')
    expect(matchingExcerpt('说明', '')).toBe('说明')
  })
})
