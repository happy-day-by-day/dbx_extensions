import { describe, expect, it } from 'vitest'
import { createTableSql } from './index'

const base = {
  table: { table_schema: 'shop', table_name: 'orders', table_comment: '订单表', engine: 'InnoDB', table_collation: 'utf8mb4_general_ci', column_count: 2 },
  columns: [
    { table_schema: 'shop', table_name: 'orders', column_name: 'id', extra: 'auto_increment', column_default: null, column_comment: '主键', column_type: 'bigint', data_type: 'bigint', column_key: 'PRI', is_nullable: 'NO', ordinal_position: 1, length: null, scale: null, character_set_name: null, collation_name: null, default_is_expression: false, generation_expression: null, generated_storage: null, is_identity: false, identity_generation: null, identity_start: null, identity_increment: null, is_computed: false, is_persisted: false, identity_seed: null },
    { table_schema: 'shop', table_name: 'orders', column_name: 'amount', extra: null, column_default: '0', column_comment: '金额', column_type: 'decimal(10,2)', data_type: 'decimal', column_key: '', is_nullable: 'YES', ordinal_position: 2, length: 10, scale: 2, character_set_name: null, collation_name: null, default_is_expression: false, generation_expression: null, generated_storage: null, is_identity: false, identity_generation: null, identity_start: null, identity_increment: null, is_computed: false, is_persisted: false, identity_seed: null }
  ] as any[],
  indexes: [
    { table_schema: 'shop', table_name: 'orders', column_name: 'id', index_name: 'PRIMARY', index_type: 'BTREE', seq: 1, non_unique: '0', index_comment: '', collation: 'A', is_primary: true, is_unique: true, is_unique_constraint: false, is_included: false, is_expression: false, predicate: '', constraint_type: '', sub_part: null, expression: '' }
  ] as any[],
  constraints: []
}

describe('createTableSql', () => {
  it('MySQL：反引号 + auto_increment + 表尾选项 + 表注释', () => {
    // 期望修正（以源实现为准）：
    // 1. 源实现固定输出 CREATE TABLE IF NOT EXISTS（三个方言中 MySQL/PG 均带 IF NOT EXISTS）；
    // 2. extra 按原样保留（仅剔除 DEFAULT_GENERATED / VIRTUAL|STORED GENERATED），'auto_increment' 输出小写（源测试同）；
    // 3. 索引列 collation 'A' 渲染为 ASC 方向后缀。
    const sql = createTableSql(base as any, 'mysql')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `shop`.`orders`')
    expect(sql).toMatch(/`id` bigint NOT NULL auto_increment/)
    expect(sql).toContain("COMMENT='订单表'")
    expect(sql).toContain('PRIMARY KEY (`id` ASC) USING BTREE')
  })
  it('MySQL：数字默认值不加引号', () => {
    expect(createTableSql(base as any, 'mysql')).toMatch(/`amount` decimal\(10,2\) DEFAULT 0/)
  })
  it('PostgreSQL：双引号 + COMMENT ON 语句', () => {
    // 期望修正：源实现 PostgreSQL 输出 CREATE TABLE IF NOT EXISTS（非裸 CREATE TABLE）。
    const sql = createTableSql(base as any, 'postgres')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "shop"."orders"')
    expect(sql).toContain("COMMENT ON TABLE")
    expect(sql).toContain("COMMENT ON COLUMN")
  })
  it('mssql：方括号 + 扩展属性', () => {
    const sql = createTableSql(base as any, 'mssql')
    expect(sql).toContain('CREATE TABLE [shop].[orders]')
    expect(sql).toMatch(/sp_addextendedproperty|sys\.sp_addextendedproperty/)
  })
  it('postgres 输入别名归一化', () => {
    expect(createTableSql(base as any, 'postgresql')).toContain('CREATE TABLE IF NOT EXISTS "shop"."orders"')
  })
})

// ---- 以下用例移植自 data-watcher createTableSql.test.mjs（node:test → vitest，断言语义不变）----

describe('createTableSql 源测试移植', () => {
  it('creates readable create table sql with columns and grouped indexes', () => {
    const tableInfo = {
      table: {
        table_name: 'orders',
        table_comment: "customer's orders"
      },
      columns: [
        {
          column_name: 'id',
          data_type: 'bigint',
          length: 20,
          is_nullable: 'NO',
          column_default: null,
          extra: 'auto_increment',
          column_comment: 'primary id'
        },
        {
          column_name: 'status',
          data_type: 'varchar',
          length: 32,
          character_set_name: 'utf8mb4',
          is_nullable: 'NO',
          column_default: 'new',
          column_comment: "order's status"
        },
        {
          column_name: 'created_at',
          data_type: 'timestamp',
          is_nullable: 'NO',
          column_default: 'CURRENT_TIMESTAMP'
        },
        {
          column_name: 'amount',
          data_type: 'decimal',
          length: 12,
          scale: 2,
          is_nullable: 'NO',
          column_default: 0
        }
      ],
      indexes: [
        {
          index_name: 'idx_status_created',
          column_name: 'created_at',
          non_unique: 1,
          seq: 2,
          index_type: 'BTREE'
        },
        {
          index_name: 'PRIMARY',
          column_name: 'id',
          non_unique: 0,
          seq: 1,
          index_type: 'BTREE'
        },
        {
          index_name: 'idx_status_created',
          column_name: 'status',
          non_unique: 1,
          seq: 1,
          index_type: 'BTREE'
        }
      ]
    }

    expect(createTableSql(tableInfo as any)).toBe(
      [
        '-- ----------------------------',
        '-- Table structure for orders',
        '-- ----------------------------',
        'CREATE TABLE IF NOT EXISTS `orders` (',
        "  `id` bigint(20) NOT NULL auto_increment COMMENT 'primary id',",
        "  `status` varchar(32) CHARACTER SET utf8mb4 NOT NULL DEFAULT 'new' COMMENT 'order''s status',",
        '  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '  `amount` decimal(12,2) NOT NULL DEFAULT 0,',
        '  PRIMARY KEY (`id`) USING BTREE,',
        '  INDEX `idx_status_created` (`status`, `created_at`) USING BTREE',
        ") COMMENT='customer''s orders';"
      ].join('\n')
    )
  })

  it('uses exact MySQL metadata for special types, generated defaults, fulltext indexes and constraints', () => {
    const sql = createTableSql(
      {
        table: {
          table_schema: 'shop',
          table_name: 'items',
          engine: 'InnoDB',
          table_collation: 'utf8mb4_0900_ai_ci'
        },
        columns: [
          {
            column_name: 'id',
            column_type: 'bigint unsigned',
            data_type: 'bigint',
            is_nullable: 'NO',
            extra: 'auto_increment'
          },
          {
            column_name: 'status',
            column_type: "enum('new','done')",
            data_type: 'enum',
            is_nullable: 'NO',
            column_default: 'new'
          },
          {
            column_name: 'created_at',
            column_type: 'timestamp(6)',
            data_type: 'timestamp',
            is_nullable: 'NO',
            column_default: 'CURRENT_TIMESTAMP(6)',
            extra: 'DEFAULT_GENERATED'
          }
        ],
        indexes: [
          { index_name: 'PRIMARY', column_name: 'id', seq: 1, index_type: 'BTREE', non_unique: 0, is_primary: true },
          { index_name: 'ft_status', column_name: 'status', seq: 1, index_type: 'FULLTEXT', non_unique: 1 }
        ],
        constraints: [
          {
            constraint_name: 'chk_status',
            constraint_type: 'CHECK',
            check_clause: "status in ('new','done')"
          }
        ]
      } as any,
      'mysql'
    )

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `shop`\.`items`/)
    expect(sql).toMatch(/`id` bigint unsigned NOT NULL auto_increment/)
    expect(sql).toMatch(/`status` enum\('new','done'\) NOT NULL DEFAULT 'new'/)
    expect(sql).toMatch(/DEFAULT CURRENT_TIMESTAMP\(6\)/)
    expect(sql).not.toMatch(/DEFAULT_GENERATED/)
    expect(sql).toMatch(/FULLTEXT INDEX `ft_status` \(`status`\)/)
    expect(sql).toMatch(/CONSTRAINT `chk_status` CHECK \(status in \('new','done'\)\)/)
    expect(sql).toMatch(/ENGINE=InnoDB DEFAULT COLLATE=utf8mb4_0900_ai_ci;/)
  })

  it('creates schema-qualified PostgreSQL DDL with native defaults, comments and separate indexes', () => {
    const sql = createTableSql(
      {
        table: {
          table_schema: 'sales',
          table_name: 'orders',
          table_comment: "customer's orders"
        },
        columns: [
          {
            column_name: 'id',
            column_type: 'bigint',
            data_type: 'bigint',
            is_nullable: 'NO',
            column_default: "nextval('sales.orders_id_seq'::regclass)",
            column_comment: "order's id"
          },
          {
            column_name: 'external_id',
            column_type: 'bigint',
            data_type: 'bigint',
            is_nullable: 'NO',
            is_identity: true,
            identity_generation: 'BY DEFAULT',
            identity_start: '10',
            identity_increment: '5'
          },
          {
            column_name: 'label',
            column_type: 'text',
            data_type: 'text',
            is_nullable: 'NO'
          }
        ],
        indexes: [
          {
            index_name: 'orders_pkey',
            column_name: 'id',
            seq: 1,
            index_type: 'btree',
            non_unique: '0',
            is_primary: true,
            constraint_type: 'p'
          },
          {
            index_name: 'orders_label_idx',
            column_name: 'lower(label)',
            seq: 1,
            index_type: 'btree',
            non_unique: '1',
            is_expression: true,
            collation: 'DESC'
          },
          {
            index_name: 'orders_label_idx',
            column_name: 'external_id',
            seq: 2,
            index_type: 'btree',
            non_unique: '1',
            is_included: true
          }
        ],
        constraints: [
          { constraint_name: 'orders_label_check', constraint_type: 'CHECK', check_clause: 'length(label) > 0' }
        ]
      } as any,
      'postgresql'
    )

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "sales"\."orders"/)
    expect(sql).toMatch(/"id" bigint DEFAULT nextval\('sales\.orders_id_seq'::regclass\) NOT NULL/)
    expect(sql).toMatch(/GENERATED BY DEFAULT AS IDENTITY \(START WITH 10 INCREMENT BY 5\) NOT NULL/)
    expect(sql).toMatch(/CONSTRAINT "orders_pkey" PRIMARY KEY \("id"\)/)
    expect(sql).toMatch(/CONSTRAINT "orders_label_check" CHECK \(length\(label\) > 0\)/)
    expect(sql).toMatch(/COMMENT ON TABLE "sales"\."orders" IS 'customer''s orders';/)
    expect(sql).toMatch(/COMMENT ON COLUMN "sales"\."orders"\."id" IS 'order''s id';/)
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "orders_label_idx" ON "sales"\."orders" USING btree \(\(lower\(label\)\) DESC\) INCLUDE \("external_id"\);/
    )
    expect(sql).not.toMatch(/`|COMMENT=/)
  })

  it('creates SQL Server DDL with identity, computed columns, included indexes and extended properties', () => {
    const sql = createTableSql(
      {
        table: {
          table_schema: 'dbo',
          table_name: 'Users',
          table_comment: "user's table"
        },
        columns: [
          {
            column_name: 'Id',
            column_type: 'int',
            data_type: 'int',
            is_nullable: 'NO',
            is_identity: true,
            identity_seed: 100,
            identity_increment: 2
          },
          {
            column_name: 'DisplayName',
            column_type: 'nvarchar(max)',
            data_type: 'nvarchar',
            is_nullable: 'YES',
            collation_name: 'Latin1_General_100_CI_AS_SC_UTF8',
            column_comment: 'Display name'
          },
          {
            column_name: 'NormalizedName',
            is_computed: true,
            generation_expression: 'upper([DisplayName])',
            is_persisted: true
          }
        ],
        indexes: [
          {
            index_name: 'PK_Users',
            column_name: 'Id',
            seq: 1,
            index_type: 'CLUSTERED',
            is_primary: true,
            is_unique: true,
            non_unique: '0',
            collation: 'ASC'
          },
          {
            index_name: 'IX_Users_Name',
            column_name: 'DisplayName',
            seq: 1,
            index_type: 'NONCLUSTERED',
            non_unique: '1',
            collation: 'ASC',
            predicate: '[DisplayName] IS NOT NULL'
          },
          {
            index_name: 'IX_Users_Name',
            column_name: 'Id',
            seq: 2,
            index_type: 'NONCLUSTERED',
            non_unique: '1',
            is_included: true
          }
        ],
        constraints: [
          { constraint_name: 'CK_Users_Name', constraint_type: 'CHECK', check_clause: '([DisplayName] IS NOT NULL)' }
        ]
      } as any,
      'mssql'
    )

    expect(sql).toMatch(/IF OBJECT_ID\(N'\[dbo\]\.\[Users\]', N'U'\) IS NULL/)
    expect(sql).toMatch(/CREATE TABLE \[dbo\]\.\[Users\]/)
    expect(sql).toMatch(/\[Id\] int IDENTITY\(100,2\) NOT NULL/)
    expect(sql).toMatch(/\[DisplayName\] nvarchar\(max\) COLLATE Latin1_General_100_CI_AS_SC_UTF8 NULL/)
    expect(sql).toMatch(/\[NormalizedName\] AS upper\(\[DisplayName\]\) PERSISTED/)
    expect(sql).toMatch(/CONSTRAINT \[PK_Users\] PRIMARY KEY CLUSTERED \(\[Id\] ASC\)/)
    expect(sql).toMatch(
      /CREATE NONCLUSTERED INDEX \[IX_Users_Name\].*INCLUDE \(\[Id\]\) WHERE \[DisplayName\] IS NOT NULL;/
    )
    expect(sql).toMatch(/EXEC sys\.sp_addextendedproperty .*@level2type = N'COLUMN'.*@level2name = N'DisplayName';/)
    expect(sql).not.toMatch(/`|CHARACTER SET|USING CLUSTERED|CREATE TABLE IF NOT EXISTS/)
  })
})
