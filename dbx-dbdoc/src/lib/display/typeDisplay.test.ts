import { describe, expect, it } from 'vitest'
import { databaseTypeKind, databaseTypeKindLabel, typeCssClass } from './typeDisplay'

describe('typeDisplay', () => {
  it('将常见数据库类型归类到稳定的视觉分组', () => {
    const cases: Record<string, string> = {
      'int(10)': 'integer',
      'integer unsigned': 'integer',
      'bigint(19)': 'bigint',
      int8: 'bigint',
      'decimal(10,2)': 'decimal',
      'numeric(18, 4)': 'decimal',
      'double precision': 'float',
      float8: 'float',
      'varchar(255)': 'varchar',
      'character varying(120)': 'varchar',
      'char(8)': 'char',
      text: 'text',
      timestamp: 'datetime',
      'timestamp without time zone': 'datetime',
      boolean: 'boolean',
      jsonb: 'json',
      bytea: 'binary',
      geometry: 'spatial',
      inet: 'network',
      'integer[]': 'array',
      custom_domain: 'other'
    }

    for (const [type, expected] of Object.entries(cases)) {
      expect(databaseTypeKind(type), type).toBe(expected)
    }
  })

  it('类型归类（brief 用例）', () => {
    expect(databaseTypeKind('bigint')).toBe('bigint')
    expect(databaseTypeKind('character varying(64)')).toBe('varchar')
    expect(databaseTypeKind('_int4')).toBe('array')
    expect(databaseTypeKind('weird')).toBe('other')
  })

  it('输出分组中文标签', () => {
    expect(databaseTypeKindLabel('jsonb')).toBe('JSON 类型')
    expect(databaseTypeKindLabel('bigint(19)')).toBe('大整数类型')
    expect(databaseTypeKindLabel('varchar(255)')).toBe('可变字符串类型')
    expect(databaseTypeKindLabel('weird')).toBe('其他类型')
  })

  it('typeCssClass 携带 chip 基类与类型类', () => {
    expect(typeCssClass('jsonb')).toBe('type-chip type-chip-json')
    expect(typeCssClass('weird')).toBe('type-chip type-chip-other')
    expect(typeCssClass('_int4')).toContain('type-chip-array')
  })
})
