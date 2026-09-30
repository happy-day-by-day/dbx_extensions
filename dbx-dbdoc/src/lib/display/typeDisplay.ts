// 类型展示纯函数：由 data-watcher databaseTypeDisplay.mjs 原样移植
// （16 类正则顺序与中文文案不变），新增 typeCssClass 供 UI chip 着色。

export type TypeKind =
  | 'array'
  | 'json'
  | 'boolean'
  | 'datetime'
  | 'bigint'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'binary'
  | 'spatial'
  | 'network'
  | 'varchar'
  | 'char'
  | 'enum'
  | 'identifier'
  | 'text'
  | 'other'

const TYPE_PATTERNS: ReadonlyArray<readonly [TypeKind, RegExp]> = [
  ['array', /(^_|\[\]$|\barray\b)/],
  ['json', /\b(json|jsonb)\b/],
  ['boolean', /\b(bool|boolean|bit)\b/],
  ['datetime', /\b(date|datetime|datetime2|smalldatetime|timestamp|timestamptz|time|timetz|year|interval)\b/],
  ['bigint', /\b(bigint|bigserial|int8)\b/],
  ['integer', /\b(tinyint|smallint|mediumint|int|integer|serial|smallserial|int2|int4)\b/],
  ['decimal', /\b(decimal|numeric|number|money|smallmoney|dec|fixed)\b/],
  ['float', /\b(float|double|double precision|real|float4|float8)\b/],
  ['binary', /\b(binary|varbinary|blob|tinyblob|mediumblob|longblob|bytea|raw|long raw|image)\b/],
  ['spatial', /\b(geometry|geography|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/],
  ['network', /\b(inet|cidr|macaddr|macaddr8)\b/],
  ['varchar', /\b(varchar|nvarchar|character varying|national character varying)\b/],
  ['char', /\b(char|nchar|character|national character)\b/],
  ['enum', /\b(enum|set)\b/],
  ['identifier', /\b(uuid|uniqueidentifier|rowid)\b/],
  ['text', /\b(text|tinytext|mediumtext|longtext|string|citext|clob|nclob|xml)\b/]
]

export const databaseTypeKind = (type: string): TypeKind => {
  const normalizedType = String(type || '').trim().toLowerCase()
  return TYPE_PATTERNS.find(([, pattern]) => pattern.test(normalizedType))?.[0] || 'other'
}

const TYPE_LABELS: Record<TypeKind, string> = {
  array: '数组类型',
  json: 'JSON 类型',
  boolean: '布尔类型',
  datetime: '日期时间类型',
  bigint: '大整数类型',
  integer: '整数类型',
  decimal: '定点数类型',
  float: '浮点数类型',
  binary: '二进制类型',
  spatial: '空间类型',
  network: '网络类型',
  varchar: '可变字符串类型',
  char: '定长字符类型',
  enum: '枚举类型',
  identifier: '标识符类型',
  text: '长文本类型',
  other: '其他类型'
}

export const databaseTypeKindLabel = (type: string): string => TYPE_LABELS[databaseTypeKind(type)]

export const typeCssClass = (type: string): string => `type-chip type-chip-${databaseTypeKind(type)}`
