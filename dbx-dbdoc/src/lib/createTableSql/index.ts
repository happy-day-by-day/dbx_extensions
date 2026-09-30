// 移植自 data-watcher apps/web/src/views/database/composables/createTableSql.mjs（行为不变）。
// 仅做：TS 类型标注；replaceAll → 等价 replace(/x/g, ...)（ES2020 lib 无 replaceAll）。
import type { DbColumn, DbConstraint, DbIndex, DbTable } from '../dialects/entities'

export interface TableInfo {
  table: DbTable
  columns: DbColumn[]
  indexes: DbIndex[]
  constraints: DbConstraint[]
}

interface GroupedIndexColumn {
  name: string
  seq: number
  direction: string
  included: boolean
  expression: boolean
  subPart: number | null
}

interface GroupedIndex {
  indexName: string
  nonUnique: string
  indexType: string
  isPrimary: boolean
  isUnique: boolean
  isUniqueConstraint: boolean
  constraintType: string
  predicate: string
  comment: string
  columns: GroupedIndexColumn[]
}

interface GroupedConstraintColumn {
  name: string
  referencedName: string
  seq: number
}

interface GroupedConstraint {
  name: string
  type: string
  referencedSchema: string
  referencedTable: string
  updateRule: string
  deleteRule: string
  checkClause: string
  columns: GroupedConstraintColumn[]
}

interface MsSqlExtendedPropertyInput {
  table: DbTable
  column?: string
  index?: string
  value: string
}

const SQL_DEFAULT_EXPRESSIONS = new Set([
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'NULL'
])

const normalizeDatabaseType = (value: unknown) => {
  const normalized = String(value || 'mysql')
    .trim()
    .toLowerCase()
  return normalized === 'postgres' ? 'postgresql' : normalized
}

const isTrue = (value: unknown) => {
  return value === true || value === 1 || /^(1|true|yes)$/i.test(String(value ?? ''))
}

const hasValue = (value: unknown) => value !== null && value !== undefined && value !== ''

const escapeSqlString = (value: unknown) => String(value ?? '').replace(/'/g, "''")

const quoteMySqlIdentifier = (value: unknown) => `\`${String(value ?? '').replace(/`/g, '``')}\``
const quotePostgreSqlIdentifier = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
const quoteMsSqlIdentifier = (value: unknown) => `[${String(value ?? '').replace(/]/g, ']]')}]`

const qualifiedName = (
  table: Pick<DbTable, 'table_schema' | 'table_name'>,
  quoteIdentifier: (value: unknown) => string,
  fallbackSchema = ''
) => {
  const schemaName = String(table?.table_schema || fallbackSchema).trim()
  const tableName = String(table?.table_name || '').trim()
  return schemaName ? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName)
}

const formatFallbackType = (column: DbColumn, dbType: string) => {
  const dataType = String(column?.data_type || '').trim()
  const normalizedType = dataType.toLowerCase()
  const length = Number(column?.length)
  const scale = Number(column?.scale)
  const hasLength = Number.isFinite(length) && length > 0
  const hasScale = Number.isFinite(scale) && scale >= 0

  if (!hasLength) {
    if (
      dbType === 'mssql' &&
      Number(column?.length) === -1 &&
      /^(binary|varbinary|char|varchar|nchar|nvarchar)$/.test(normalizedType)
    ) {
      return `${dataType}(max)`
    }
    return dataType
  }

  if (/^(decimal|numeric|number)$/.test(normalizedType)) {
    return hasScale ? `${dataType}(${length},${scale})` : `${dataType}(${length})`
  }

  if (dbType === 'mssql') {
    return /^(binary|varbinary|char|varchar|nchar|nvarchar|datetime2|datetimeoffset|time|float)$/.test(normalizedType)
      ? `${dataType}(${length})`
      : dataType
  }

  return `${dataType}(${length})`
}

const formatColumnType = (column: DbColumn, dbType: string) => {
  const exactType = String(column?.column_type || '').trim()
  return exactType || formatFallbackType(column, dbType)
}

const isDefaultExpression = (value: unknown) => {
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.trim().toUpperCase()
  return SQL_DEFAULT_EXPRESSIONS.has(normalized) || /^CURRENT_(?:DATE|TIME|TIMESTAMP)(?:\(\d*\))?$/.test(normalized)
}

const MYSQL_NUMERIC_TYPES =
  /^(?:bit|tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|bool|boolean|year)$/i

const formatMySqlDefault = (column: DbColumn) => {
  const value = column?.column_default
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value).trim()
  const extra = String(column?.extra || '')
  const isGeneratedDefault = /\bDEFAULT_GENERATED\b/i.test(extra) || isTrue(column?.default_is_expression)
  if (isGeneratedDefault && !isDefaultExpression(text)) {
    const expression = text.startsWith('(') && text.endsWith(')') ? text : `(${text})`
    return ` DEFAULT ${expression}`
  }
  const isNumericLiteral =
    MYSQL_NUMERIC_TYPES.test(String(column?.data_type || '')) &&
    /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text)
  if (isDefaultExpression(text) || /^(?:b|x)'[^']*'$/i.test(text) || isNumericLiteral) {
    return ` DEFAULT ${text}`
  }
  return ` DEFAULT '${escapeSqlString(value)}'`
}

const mysqlExtra = (column: DbColumn) => {
  return String(column?.extra || '')
    .replace(/\bDEFAULT_GENERATED\b/gi, '')
    .replace(/\b(?:VIRTUAL|STORED)\s+GENERATED\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const indexDirection = (value: unknown) => {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
  if (normalized === 'D' || normalized === 'DESC' || normalized === '1') {
    return 'DESC'
  }
  if (normalized === 'A' || normalized === 'ASC' || normalized === '0') {
    return 'ASC'
  }
  return ''
}

const groupIndexes = (indexes: DbIndex[] = []) => {
  const grouped = new Map<string, GroupedIndex>()
  for (const sourceIndex of Array.isArray(indexes) ? indexes : []) {
    const indexName = String(sourceIndex?.index_name || '').trim()
    const columnName = String(sourceIndex?.column_name || sourceIndex?.expression || '').trim()
    if (!indexName || !columnName) {
      continue
    }
    if (!grouped.has(indexName)) {
      grouped.set(indexName, {
        indexName,
        nonUnique: sourceIndex?.non_unique,
        indexType: String(sourceIndex?.index_type || 'BTREE').trim(),
        isPrimary: isTrue(sourceIndex?.is_primary) || indexName.toUpperCase() === 'PRIMARY',
        isUnique: isTrue(sourceIndex?.is_unique) || Number(sourceIndex?.non_unique) === 0,
        isUniqueConstraint: isTrue(sourceIndex?.is_unique_constraint),
        constraintType: String(sourceIndex?.constraint_type || '')
          .trim()
          .toLowerCase(),
        predicate: String(sourceIndex?.predicate || '').trim(),
        comment: String(sourceIndex?.index_comment || '').trim(),
        columns: []
      })
    }
    const isExpression =
      isTrue(sourceIndex?.is_expression) || Boolean(!sourceIndex?.column_name && sourceIndex?.expression)
    grouped.get(indexName)!.columns.push({
      name: columnName,
      seq: Number(sourceIndex?.seq) || 0,
      direction: indexDirection(sourceIndex?.collation),
      included: isTrue(sourceIndex?.is_included),
      expression: isExpression,
      subPart: Number(sourceIndex?.sub_part) > 0 ? Number(sourceIndex.sub_part) : null
    })
  }
  return [...grouped.values()]
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
    .map((indexInfo) => ({
      ...indexInfo,
      columns: indexInfo.columns.sort((a, b) => a.seq - b.seq)
    }))
}

const groupConstraints = (constraints: DbConstraint[] = []) => {
  const grouped = new Map<string, GroupedConstraint>()
  for (const sourceConstraint of Array.isArray(constraints) ? constraints : []) {
    const name = String(sourceConstraint?.constraint_name || '').trim()
    const type = String(sourceConstraint?.constraint_type || '')
      .trim()
      .toUpperCase()
    if (!name || !type) {
      continue
    }
    const key = `${type}:${name}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        name,
        type,
        referencedSchema: String(sourceConstraint?.referenced_schema || '').trim(),
        referencedTable: String(sourceConstraint?.referenced_table || '').trim(),
        updateRule: String(sourceConstraint?.update_rule || '')
          .trim()
          .toUpperCase(),
        deleteRule: String(sourceConstraint?.delete_rule || '')
          .trim()
          .toUpperCase(),
        checkClause: String(sourceConstraint?.check_clause || '').trim(),
        columns: []
      })
    }
    const columnName = String(sourceConstraint?.column_name || '').trim()
    if (columnName) {
      grouped.get(key)!.columns.push({
        name: columnName,
        referencedName: String(sourceConstraint?.referenced_column || '').trim(),
        seq: Number(sourceConstraint?.seq) || 0
      })
    }
  }
  return [...grouped.values()].map((constraint) => ({
    ...constraint,
    columns: constraint.columns.sort((a, b) => a.seq - b.seq)
  }))
}

const referenceAction = (keyword: string, value: string) => {
  const supported = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'])
  return supported.has(value) ? ` ${keyword} ${value}` : ''
}

const formatCheckClause = (value: unknown) => {
  const clause = String(value || '').trim()
  return clause.startsWith('(') && clause.endsWith(')') ? clause : `(${clause})`
}

const renderForeignKey = (
  constraint: GroupedConstraint,
  quoteIdentifier: (value: unknown) => string,
  defaultReferencedSchema = ''
) => {
  const columns = constraint.columns.map((column) => quoteIdentifier(column.name)).join(', ')
  const referencedColumns = constraint.columns.map((column) => quoteIdentifier(column.referencedName)).join(', ')
  const referencedTable = qualifiedName(
    {
      table_schema: constraint.referencedSchema || defaultReferencedSchema,
      table_name: constraint.referencedTable
    },
    quoteIdentifier
  )
  return `CONSTRAINT ${quoteIdentifier(
    constraint.name
  )} FOREIGN KEY (${columns}) REFERENCES ${referencedTable} (${referencedColumns})${referenceAction(
    'ON UPDATE',
    constraint.updateRule
  )}${referenceAction('ON DELETE', constraint.deleteRule)}`
}

const createMySql = (tableInfoData: TableInfo) => {
  const table: DbTable = tableInfoData?.table ?? ({} as DbTable)
  const tableName = qualifiedName(table, quoteMySqlIdentifier)
  const definitions: string[] = []

  for (const column of Array.isArray(tableInfoData?.columns) ? tableInfoData.columns : []) {
    let line = `${quoteMySqlIdentifier(column.column_name)} ${formatColumnType(column, 'mysql')}`
    if (column.character_set_name) {
      line += ` CHARACTER SET ${column.character_set_name}`
    }
    if (column.collation_name) {
      line += ` COLLATE ${column.collation_name}`
    }
    const generationExpression = String(column.generation_expression || '').trim()
    if (generationExpression) {
      const storage = /\bSTORED\b/i.test(String(column.extra || '')) ? 'STORED' : 'VIRTUAL'
      line += ` GENERATED ALWAYS AS (${generationExpression}) ${storage}`
    }
    if (column.is_nullable === 'NO') {
      line += ' NOT NULL'
    }
    if (!generationExpression) {
      line += formatMySqlDefault(column)
      const extra = mysqlExtra(column)
      if (extra) {
        line += ` ${extra}`
      }
    }
    if (column.column_comment) {
      line += ` COMMENT '${escapeSqlString(column.column_comment)}'`
    }
    definitions.push(line)
  }

  for (const indexInfo of groupIndexes(tableInfoData?.indexes)) {
    const indexType = indexInfo.indexType.toUpperCase()
    const columns = indexInfo.columns
      .map((column) => {
        const source = column.expression ? `(${column.name})` : quoteMySqlIdentifier(column.name)
        const prefix = column.subPart ? `(${column.subPart})` : ''
        const direction = column.direction ? ` ${column.direction}` : ''
        return `${source}${prefix}${direction}`
      })
      .join(', ')
    if (indexInfo.isPrimary) {
      const using = /^(BTREE|HASH)$/.test(indexType) ? ` USING ${indexType}` : ''
      definitions.push(`PRIMARY KEY (${columns})${using}`)
    } else if (indexType === 'FULLTEXT' || indexType === 'SPATIAL') {
      definitions.push(`${indexType} INDEX ${quoteMySqlIdentifier(indexInfo.indexName)} (${columns})`)
    } else {
      const unique = indexInfo.isUnique ? 'UNIQUE ' : ''
      const using = /^(BTREE|HASH)$/.test(indexType) ? ` USING ${indexType}` : ''
      definitions.push(`${unique}INDEX ${quoteMySqlIdentifier(indexInfo.indexName)} (${columns})${using}`)
    }
  }

  for (const constraint of groupConstraints(tableInfoData?.constraints)) {
    if (constraint.type === 'FOREIGN KEY') {
      definitions.push(renderForeignKey(constraint, quoteMySqlIdentifier, table.table_schema))
    } else if (constraint.type === 'CHECK' && constraint.checkClause) {
      definitions.push(
        `CONSTRAINT ${quoteMySqlIdentifier(constraint.name)} CHECK ${formatCheckClause(constraint.checkClause)}`
      )
    }
  }

  const options: string[] = []
  if (table.engine) {
    options.push(`ENGINE=${table.engine}`)
  }
  if (table.table_collation) {
    options.push(`DEFAULT COLLATE=${table.table_collation}`)
  }
  if (table.table_comment) {
    options.push(`COMMENT='${escapeSqlString(table.table_comment)}'`)
  }
  const suffix = options.length ? ` ${options.join(' ')}` : ''
  return [
    '-- ----------------------------',
    `-- Table structure for ${String(table.table_name || '')}`,
    '-- ----------------------------',
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    definitions.map((line) => `  ${line}`).join(',\n'),
    `)${suffix};`
  ].join('\n')
}

const createPostgreSql = (tableInfoData: TableInfo) => {
  const table: DbTable = tableInfoData?.table ?? ({} as DbTable)
  const tableName = qualifiedName(table, quotePostgreSqlIdentifier, 'public')
  const definitions: string[] = []
  const indexes = groupIndexes(tableInfoData?.indexes)

  for (const column of Array.isArray(tableInfoData?.columns) ? tableInfoData.columns : []) {
    let line = `${quotePostgreSqlIdentifier(column.column_name)} ${formatColumnType(column, 'postgresql')}`
    if (column.collation_name) {
      line += ` COLLATE ${quotePostgreSqlIdentifier(column.collation_name)}`
    }
    const generationExpression = String(column.generation_expression || '').trim()
    if (generationExpression) {
      line += ` GENERATED ALWAYS AS (${generationExpression}) ${String(
        column.generated_storage || 'STORED'
      ).toUpperCase()}`
    } else if (isTrue(column.is_identity)) {
      const generation =
        String(column.identity_generation || 'BY DEFAULT').toUpperCase() === 'ALWAYS' ? 'ALWAYS' : 'BY DEFAULT'
      const identityOptions: string[] = []
      if (hasValue(column.identity_start)) {
        identityOptions.push(`START WITH ${column.identity_start}`)
      }
      if (hasValue(column.identity_increment)) {
        identityOptions.push(`INCREMENT BY ${column.identity_increment}`)
      }
      line += ` GENERATED ${generation} AS IDENTITY${identityOptions.length ? ` (${identityOptions.join(' ')})` : ''}`
    } else if (column.column_default != null) {
      line += ` DEFAULT ${column.column_default}`
    }
    if (column.is_nullable === 'NO') {
      line += ' NOT NULL'
    }
    definitions.push(line)
  }

  for (const indexInfo of indexes.filter(
    (index) =>
      index.isPrimary || index.constraintType === 'p' || index.isUniqueConstraint || index.constraintType === 'u'
  )) {
    const columns = indexInfo.columns
      .filter((column) => !column.included)
      .map((column) => quotePostgreSqlIdentifier(column.name))
      .join(', ')
    const kind = indexInfo.isPrimary || indexInfo.constraintType === 'p' ? 'PRIMARY KEY' : 'UNIQUE'
    definitions.push(`CONSTRAINT ${quotePostgreSqlIdentifier(indexInfo.indexName)} ${kind} (${columns})`)
  }

  for (const constraint of groupConstraints(tableInfoData?.constraints)) {
    if (constraint.type === 'FOREIGN KEY') {
      definitions.push(renderForeignKey(constraint, quotePostgreSqlIdentifier, table.table_schema || 'public'))
    } else if (constraint.type === 'CHECK' && constraint.checkClause) {
      definitions.push(
        `CONSTRAINT ${quotePostgreSqlIdentifier(constraint.name)} CHECK ${formatCheckClause(constraint.checkClause)}`
      )
    }
  }

  const statements = [
    '-- ----------------------------',
    `-- Table structure for ${String(table.table_name || '')}`,
    '-- ----------------------------',
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    definitions.map((line) => `  ${line}`).join(',\n'),
    ');'
  ]

  if (table.table_comment) {
    statements.push(`COMMENT ON TABLE ${tableName} IS '${escapeSqlString(table.table_comment)}';`)
  }
  for (const column of Array.isArray(tableInfoData?.columns) ? tableInfoData.columns : []) {
    if (column.column_comment) {
      statements.push(
        `COMMENT ON COLUMN ${tableName}.${quotePostgreSqlIdentifier(column.column_name)} IS '${escapeSqlString(
          column.column_comment
        )}';`
      )
    }
  }

  for (const indexInfo of indexes.filter(
    (index) =>
      !index.isPrimary && index.constraintType !== 'p' && !index.isUniqueConstraint && index.constraintType !== 'u'
  )) {
    const keyColumns = indexInfo.columns
      .filter((column) => !column.included)
      .map((column) => {
        const source = column.expression ? `(${column.name})` : quotePostgreSqlIdentifier(column.name)
        return `${source}${column.direction ? ` ${column.direction}` : ''}`
      })
      .join(', ')
    const includedColumns = indexInfo.columns
      .filter((column) => column.included)
      .map((column) => quotePostgreSqlIdentifier(column.name))
    const unique = indexInfo.isUnique ? 'UNIQUE ' : ''
    const method = indexInfo.indexType ? ` USING ${indexInfo.indexType.toLowerCase()}` : ''
    const include = includedColumns.length ? ` INCLUDE (${includedColumns.join(', ')})` : ''
    const predicate = indexInfo.predicate ? ` WHERE ${indexInfo.predicate}` : ''
    statements.push(
      `CREATE ${unique}INDEX IF NOT EXISTS ${quotePostgreSqlIdentifier(
        indexInfo.indexName
      )} ON ${tableName}${method} (${keyColumns})${include}${predicate};`
    )
    if (indexInfo.comment) {
      const indexName = qualifiedName(
        { table_schema: table.table_schema || 'public', table_name: indexInfo.indexName },
        quotePostgreSqlIdentifier
      )
      statements.push(`COMMENT ON INDEX ${indexName} IS '${escapeSqlString(indexInfo.comment)}';`)
    }
  }
  return statements.join('\n')
}

const msSqlUnicodeString = (value: unknown) => `N'${escapeSqlString(value)}'`

const createMsSqlExtendedProperty = ({ table, column, index, value }: MsSqlExtendedPropertyInput) => {
  const schemaName = String(table.table_schema || 'dbo')
  const parameters = [
    "@name = N'MS_Description'",
    `@value = ${msSqlUnicodeString(value)}`,
    "@level0type = N'SCHEMA'",
    `@level0name = ${msSqlUnicodeString(schemaName)}`,
    "@level1type = N'TABLE'",
    `@level1name = ${msSqlUnicodeString(table.table_name)}`
  ]
  if (column) {
    parameters.push("@level2type = N'COLUMN'", `@level2name = ${msSqlUnicodeString(column)}`)
  } else if (index) {
    parameters.push("@level2type = N'INDEX'", `@level2name = ${msSqlUnicodeString(index)}`)
  }
  return `EXEC sys.sp_addextendedproperty ${parameters.join(', ')};`
}

const createMsSql = (tableInfoData: TableInfo) => {
  const table: DbTable = tableInfoData?.table ?? ({} as DbTable)
  const tableName = qualifiedName(table, quoteMsSqlIdentifier, 'dbo')
  const definitions: string[] = []
  const indexes = groupIndexes(tableInfoData?.indexes)

  for (const column of Array.isArray(tableInfoData?.columns) ? tableInfoData.columns : []) {
    const generationExpression = String(column.generation_expression || '').trim()
    if (isTrue(column.is_computed) || generationExpression) {
      definitions.push(
        `${quoteMsSqlIdentifier(column.column_name)} AS ${generationExpression}${
          isTrue(column.is_persisted) ? ' PERSISTED' : ''
        }`
      )
      continue
    }
    let line = `${quoteMsSqlIdentifier(column.column_name)} ${formatColumnType(column, 'mssql')}`
    if (column.collation_name) {
      line += ` COLLATE ${column.collation_name}`
    }
    if (column.column_default != null && !isTrue(column.is_identity)) {
      line += ` DEFAULT ${column.column_default}`
    }
    if (isTrue(column.is_identity)) {
      const seed = hasValue(column.identity_seed) ? column.identity_seed : 1
      const increment = hasValue(column.identity_increment) ? column.identity_increment : 1
      line += ` IDENTITY(${seed},${increment})`
    }
    line += column.is_nullable === 'NO' ? ' NOT NULL' : ' NULL'
    definitions.push(line)
  }

  for (const indexInfo of indexes.filter((index) => index.isPrimary || index.isUniqueConstraint)) {
    const columns = indexInfo.columns
      .filter((column) => !column.included)
      .map((column) => `${quoteMsSqlIdentifier(column.name)}${column.direction ? ` ${column.direction}` : ''}`)
      .join(', ')
    const kind = indexInfo.isPrimary ? 'PRIMARY KEY' : 'UNIQUE'
    const storage = /CLUSTERED/i.test(indexInfo.indexType) ? indexInfo.indexType.toUpperCase() : 'NONCLUSTERED'
    definitions.push(`CONSTRAINT ${quoteMsSqlIdentifier(indexInfo.indexName)} ${kind} ${storage} (${columns})`)
  }

  for (const constraint of groupConstraints(tableInfoData?.constraints)) {
    if (constraint.type === 'FOREIGN KEY') {
      definitions.push(renderForeignKey(constraint, quoteMsSqlIdentifier, table.table_schema || 'dbo'))
    } else if (constraint.type === 'CHECK' && constraint.checkClause) {
      definitions.push(
        `CONSTRAINT ${quoteMsSqlIdentifier(constraint.name)} CHECK ${formatCheckClause(constraint.checkClause)}`
      )
    }
  }

  const body = [`  CREATE TABLE ${tableName} (`, definitions.map((line) => `    ${line}`).join(',\n'), '  );']

  for (const indexInfo of indexes.filter((index) => !index.isPrimary && !index.isUniqueConstraint)) {
    const keyColumns = indexInfo.columns
      .filter((column) => !column.included)
      .map((column) => `${quoteMsSqlIdentifier(column.name)}${column.direction ? ` ${column.direction}` : ''}`)
      .join(', ')
    const includedColumns = indexInfo.columns
      .filter((column) => column.included)
      .map((column) => quoteMsSqlIdentifier(column.name))
    const unique = indexInfo.isUnique ? 'UNIQUE ' : ''
    const storage = /^(CLUSTERED|NONCLUSTERED)$/i.test(indexInfo.indexType)
      ? `${indexInfo.indexType.toUpperCase()} `
      : 'NONCLUSTERED '
    const include = includedColumns.length ? ` INCLUDE (${includedColumns.join(', ')})` : ''
    const predicate = indexInfo.predicate ? ` WHERE ${indexInfo.predicate}` : ''
    body.push(
      `  CREATE ${unique}${storage}INDEX ${quoteMsSqlIdentifier(
        indexInfo.indexName
      )} ON ${tableName} (${keyColumns})${include}${predicate};`
    )
  }

  if (table.table_comment) {
    body.push(`  ${createMsSqlExtendedProperty({ table, value: table.table_comment })}`)
  }
  for (const column of Array.isArray(tableInfoData?.columns) ? tableInfoData.columns : []) {
    if (column.column_comment) {
      body.push(`  ${createMsSqlExtendedProperty({ table, column: column.column_name, value: column.column_comment })}`)
    }
  }
  for (const indexInfo of indexes) {
    if (indexInfo.comment) {
      body.push(`  ${createMsSqlExtendedProperty({ table, index: indexInfo.indexName, value: indexInfo.comment })}`)
    }
  }

  const objectName = qualifiedName(table, quoteMsSqlIdentifier, 'dbo')
  return [
    '-- ----------------------------',
    `-- Table structure for ${String(table.table_name || '')}`,
    '-- ----------------------------',
    `IF OBJECT_ID(${msSqlUnicodeString(objectName)}, N'U') IS NULL`,
    'BEGIN',
    ...body,
    'END;'
  ].join('\n')
}

export const createTableSql = (tableInfoData: TableInfo, databaseType: string = 'mysql'): string => {
  const dbType = normalizeDatabaseType(databaseType)
  if (dbType === 'postgresql') {
    return createPostgreSql(tableInfoData)
  }
  if (dbType === 'mssql') {
    return createMsSql(tableInfoData)
  }
  return createMySql(tableInfoData)
}
