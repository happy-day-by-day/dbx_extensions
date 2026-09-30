import { describe, expect, it } from 'vitest'
import type { DbIndex } from '../dialects/entities'
import {
  databaseIndexAlgorithm,
  databaseIndexDirection,
  databaseIndexDisplayTitle,
  databaseIndexKind,
  databaseIndexKindLabel,
  databaseIndexSequence
} from './indexDisplay'

const makeIndex = (overrides: Partial<DbIndex> = {}): DbIndex => ({
  table_schema: 'shop',
  table_name: 'orders',
  column_name: 'id',
  index_name: '',
  index_type: '',
  seq: 1,
  non_unique: '1',
  index_comment: '',
  collation: '',
  is_primary: false,
  is_unique: false,
  is_unique_constraint: false,
  is_included: false,
  is_expression: false,
  predicate: '',
  constraint_type: '',
  sub_part: null,
  expression: '',
  ...overrides
})

describe('indexDisplay', () => {
  it('格式化主键索引的类型、算法、序号与方向', () => {
    const indexInfo = makeIndex({ index_name: 'PRIMARY', index_type: 'BTREE', non_unique: '0', seq: 1, collation: 'A' })

    expect(databaseIndexKind(indexInfo)).toBe('primary')
    expect(databaseIndexKindLabel(indexInfo)).toBe('主键')
    expect(databaseIndexAlgorithm(indexInfo)).toBe('BTREE')
    expect(databaseIndexSequence(indexInfo)).toBe(1)
    expect(databaseIndexDirection(indexInfo)).toBe('ASC')
    expect(databaseIndexDisplayTitle(indexInfo)).toBe('PRIMARY · 主键 · BTREE · 第 1 位 · ASC')
  })

  it('区分唯一/普通索引并保留复合序号', () => {
    expect(databaseIndexKind(makeIndex({ index_name: 'users_email_key', non_unique: '0' }))).toBe('unique')
    expect(databaseIndexKind(makeIndex({ index_name: 'users_pkey', non_unique: '0' }))).toBe('primary')
    expect(databaseIndexKindLabel(makeIndex({ index_name: 'idx_status_created', non_unique: '1' }))).toBe('普通')
    expect(databaseIndexSequence(makeIndex({ seq: 2 }))).toBe(2)
    expect(databaseIndexDirection(makeIndex({ collation: 'D' }))).toBe('DESC')
  })

  it('主键识别（PRIMARY / _pkey 后缀）', () => {
    expect(databaseIndexKind({ index_name: 'PRIMARY', non_unique: '0' } as any)).toBe('primary')
    expect(databaseIndexKind({ index_name: 'orders_pkey', non_unique: '0' } as any)).toBe('primary')
  })

  it('唯一/普通按 non_unique 判定', () => {
    expect(databaseIndexKind({ index_name: 'uk_name', non_unique: '0' } as any)).toBe('unique')
    expect(databaseIndexKind({ index_name: 'idx_name', non_unique: '1' } as any)).toBe('normal')
  })

  it('non_unique 容忍数值形态', () => {
    expect(databaseIndexKind({ index_name: 'uk_num', non_unique: 0 } as any)).toBe('unique')
    expect(databaseIndexKind({ index_name: 'idx_num', non_unique: 1 } as any)).toBe('normal')
  })

  it('缺省字段回退（未命名索引 / 序号至少为 1 / 算法占位 / 方向为空）', () => {
    expect(databaseIndexDisplayTitle(makeIndex())).toBe('未命名索引 · 普通 · — · 第 1 位')
    expect(databaseIndexSequence(makeIndex({ seq: undefined }))).toBe(1)
    expect(databaseIndexDirection(makeIndex({ collation: 'asc' }))).toBe('ASC')
    expect(databaseIndexDirection(makeIndex({ collation: '' }))).toBe('')
  })
})
