import { describe, expect, it } from 'vitest'
import { anchorOf, renderSchemaMarkdown, renderTableMarkdown, type TableDetail } from './markdown'
import type { DbColumn, DbConstraint, DbIndex, DbTable } from './dialects/entities'

const detail = {
  table: { table_schema: 'shop', table_name: 'orders', table_comment: '订单表', engine: 'InnoDB', table_collation: 'utf8mb4_general_ci', column_count: 1 },
  columns: [{ table_schema: 'shop', table_name: 'orders', column_name: 'id', extra: null, column_default: null, column_comment: '主键|编号', column_type: 'bigint', data_type: 'bigint', column_key: 'PRI', is_nullable: 'NO', ordinal_position: 1, length: null, scale: null, character_set_name: null, collation_name: null, default_is_expression: false, generation_expression: null, generated_storage: null, is_identity: false, identity_generation: null, identity_start: null, identity_increment: null, is_computed: false, is_persisted: false, identity_seed: null }],
  indexes: [],
  constraints: []
} as any

describe('markdown', () => {
  it('不支持检查约束时导出能力说明，避免误报为完整约束清单', () => {
    const md = renderTableMarkdown({ ...detail, checksSupported: false }, 'mysql')
    expect(md).toContain('当前数据库版本不提供检查约束元数据')
    expect(md).not.toContain('检查约束未能读取')
    expect(md).toContain('| id | bigint | NO |')
  })
  it('表格内竖线转义', () => {
    const md = renderTableMarkdown(detail, 'mysql')
    expect(md).toContain('主键\\|编号')
    expect(md).toContain('# orders 订单表')
    expect(md).toContain('| id | bigint | NO |')
  })
  it('整库文档含目录锚点与建表 SQL（四反引号栅栏）', () => {
    const md = renderSchemaMarkdown('shop', [detail, detail], 'mysql')
    expect(md).toContain('# shop 数据字典')
    expect(md).toContain('- [orders 订单表](#orders-订单表)')
    expect(md).toContain('````sql')
  })
})

const richTable: DbTable = {
  table_schema: 'shop',
  table_name: 'user orders',
  table_comment: '',
  engine: 'InnoDB',
  table_collation: 'utf8mb4_general_ci',
  column_count: 2
}

const mkColumn = (overrides: Partial<DbColumn> = {}): DbColumn => ({
  table_schema: 'shop',
  table_name: 'user orders',
  column_name: 'id',
  extra: null,
  column_default: null,
  column_comment: '',
  column_type: 'bigint',
  data_type: 'bigint',
  column_key: 'PRI',
  is_nullable: 'NO',
  ordinal_position: 1,
  length: null,
  scale: null,
  character_set_name: null,
  collation_name: null,
  default_is_expression: false,
  generation_expression: null,
  generated_storage: null,
  is_identity: false,
  identity_generation: null,
  identity_start: null,
  identity_increment: null,
  is_computed: false,
  is_persisted: false,
  identity_seed: null,
  ...overrides
})

const mkIndex = (overrides: Partial<DbIndex> = {}): DbIndex => ({
  table_schema: 'shop',
  table_name: 'user orders',
  column_name: 'id',
  index_name: 'PRIMARY',
  index_type: 'BTREE',
  seq: 1,
  non_unique: '0',
  index_comment: '',
  collation: 'A',
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

const mkConstraint = (overrides: Partial<DbConstraint> = {}): DbConstraint => ({
  table_schema: 'shop',
  table_name: 'user orders',
  constraint_name: 'fk_order_user',
  constraint_type: 'FOREIGN KEY',
  column_name: 'user_id',
  seq: 1,
  referenced_schema: 'shop',
  referenced_table: 'users',
  referenced_column: 'id',
  update_rule: 'CASCADE',
  delete_rule: 'SET NULL',
  check_clause: '',
  ...overrides
})

const richDetail: TableDetail = {
  table: richTable,
  columns: [
    mkColumn({ ordinal_position: 1 }),
    mkColumn({
      column_name: 'user_id',
      column_type: 'bigint',
      column_key: 'MUL',
      column_comment: '多行\n注释|带竖线',
      column_default: '0',
      ordinal_position: 2
    })
  ],
  indexes: [
    mkIndex({ index_name: 'PRIMARY', column_name: 'id', seq: 1, non_unique: '0', index_type: 'BTREE' }),
    mkIndex({ index_name: 'uk_order_user', column_name: 'user_id', seq: 2, non_unique: '0', index_type: 'BTREE' }),
    mkIndex({ index_name: 'idx_user', column_name: 'user_id', seq: 1, non_unique: '1', index_type: 'HASH' })
  ],
  constraints: [
    mkConstraint({ constraint_name: 'fk_order_user', column_name: 'user_id', seq: 1 }),
    mkConstraint({
      constraint_name: 'chk_amount',
      constraint_type: 'CHECK',
      column_name: '',
      check_clause: 'amount > 0'
    })
  ]
}

describe('markdown 扩展场景', () => {
  it('anchorOf：小写、空格转连字符、移除非中英文数字连字符字符', () => {
    expect(anchorOf('User Orders 订单 表')).toBe('user-orders-订单-表')
    expect(anchorOf('a@b#c')).toBe('abc')
    expect(anchorOf('orders')).toBe('orders')
  })

  it('索引 chip、索引清单与约束清单（外键 + CHECK）', () => {
    const md = renderTableMarkdown(richDetail, 'mysql')
    expect(md).toContain('## user orders')
    expect(md).toContain('PRIMARY(主键)')
    expect(md).toContain('uk_order_user(唯一) idx_user(普通)')
    expect(md).toContain('- **PRIMARY**（主键） · 列: id · 算法: BTREE')
    expect(md).toContain('- **idx_user**（普通） · 列: user_id · 算法: HASH')
    expect(md).toContain('(user_id) → shop.users(id) ON UPDATE CASCADE ON DELETE SET NULL')
    expect(md).toContain('- **chk_amount**（CHECK）: amount > 0')
    expect(md).toContain('多行 注释\\|带竖线')
    expect(md).toContain('| 2 | user_id | bigint | NO | 0 | ')
    expect(md).toContain('CREATE TABLE IF NOT EXISTS `shop`.`user orders`')
  })

  it('目录锚点与正文标题自洽（空注释仅表名）', () => {
    const md = renderSchemaMarkdown('shop', [richDetail], 'mysql')
    expect(md).toContain('- [user orders](#user-orders)')
    expect(md).toContain('## user orders')
    expect(md).toMatch(/生成时间：\d{4}-\d{2}-\d{2}/)
  })

  it('字段注释含字面 \\| 与三反引号：先转义反斜杠再转义竖线，四反引号栅栏不被打断', () => {
    const tricky: TableDetail = {
      ...richDetail,
      columns: [
        mkColumn({ column_name: 'flag', column_type: 'varchar(10)', column_comment: 'a\\|b' }),
        mkColumn({ column_name: 'note', column_type: 'text', column_comment: '含```代码块' })
      ]
    }
    const md = renderTableMarkdown(tricky, 'mysql')
    // 输入 a\|b：\ 先转义为 \\，| 再转义为 \| → 单元格出现 a\\\|b（GFM 渲染回字面 a\|b）
    expect(md).toContain('a\\\\\\|b')
    expect(md).not.toContain('\n```sql\n')
    expect(md).toContain('\n````sql\n')
    expect(md.trimEnd().endsWith('````')).toBe(true)
    // 注释中的 ``` 原样保留（单元格 + 建表 SQL 注释内），不打断栅栏
    expect(md).toContain('含```代码块')
  })
})
