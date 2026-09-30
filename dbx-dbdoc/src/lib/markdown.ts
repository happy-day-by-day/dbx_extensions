// 表/整库 Markdown 数据字典文档渲染（纯函数，供 Task 10 导出文档复用）。
import type { DbColumn, DbConstraint, DbIndex, DbTable } from './dialects/entities'
import { createTableSql } from './createTableSql'
import { dateStamp } from './date'
import { databaseIndexAlgorithm, databaseIndexKindLabel } from './display/indexDisplay'

export interface TableDetail {
  table: DbTable
  columns: DbColumn[]
  indexes: DbIndex[]
  constraints: DbConstraint[]
  warnings?: string[]
  checksSupported?: boolean
}

// 单元格文本：换行折叠为空格 → 反斜杠转义 → 竖线转义，避免破坏表格结构。
// 顺序必须是先 \ 后 |：数据含字面 `\|` 时，若先转义 | 会得到 `\\|`，
// GFM 里渲染成字面反斜杠 + 未转义竖线（列错位）；先转义 \ 得 `\\\|` 才能渲染回 `\|`。
const cell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')

const hasText = (value: unknown): boolean =>
  value !== null && value !== undefined && String(value).trim() !== ''

// 章节标题文本：表名 + 注释（注释为空时仅表名）。
const tableTitle = (table: DbTable): string =>
  [String(table?.table_name || '').trim(), String(table?.table_comment || '').trim()].filter(Boolean).join(' ')

// GitHub 风格锚点：小写、空格转 -、非 [a-z0-9 中文 -] 字符移除。
export const anchorOf = (text: string): string =>
  String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ /g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')

interface GroupedIndexRow {
  name: string
  first: DbIndex
  columns: string[]
}

// 按 index_name 分组，列按 seq 升序。
const groupIndexRows = (indexes: DbIndex[]): GroupedIndexRow[] => {
  const groups = new Map<string, DbIndex[]>()
  for (const index of Array.isArray(indexes) ? indexes : []) {
    const name = String(index?.index_name || '').trim()
    if (!name) {
      continue
    }
    const rows = groups.get(name) ?? []
    rows.push(index)
    groups.set(name, rows)
  }
  return [...groups.entries()].map(([name, rows]) => ({
    name,
    first: rows[0],
    columns: [...rows]
      .sort((left, right) => (Number(left?.seq) || 0) - (Number(right?.seq) || 0))
      .map((row) => String(row?.column_name || row?.expression || '').trim())
      .filter(Boolean)
  }))
}

// 字段命中的索引 chip 文本：名(类型)，空格连接。
const columnIndexChips = (columnName: string, groups: GroupedIndexRow[]): string =>
  groups
    .filter((group) => group.columns.includes(columnName))
    .map((group) => `${group.name}(${databaseIndexKindLabel(group.first)})`)
    .join(' ')

interface GroupedConstraintRow {
  name: string
  type: string
  columns: string[]
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  updateRule: string
  deleteRule: string
  checkClause: string
}

const groupConstraintRows = (constraints: DbConstraint[]): GroupedConstraintRow[] => {
  const groups = new Map<string, DbConstraint[]>()
  for (const constraint of Array.isArray(constraints) ? constraints : []) {
    const name = String(constraint?.constraint_name || '').trim()
    const type = String(constraint?.constraint_type || '').trim().toUpperCase()
    if (!name || !type) {
      continue
    }
    const key = `${type}:${name}`
    const rows = groups.get(key) ?? []
    rows.push(constraint)
    groups.set(key, rows)
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [type, name] = key.split(':') as [string, string]
    const ordered = [...rows].sort((left, right) => (Number(left?.seq) || 0) - (Number(right?.seq) || 0))
    return {
      name,
      type,
      columns: ordered.map((row) => String(row?.column_name || '').trim()).filter(Boolean),
      referencedSchema: String(rows[0]?.referenced_schema || '').trim(),
      referencedTable: String(rows[0]?.referenced_table || '').trim(),
      referencedColumns: ordered.map((row) => String(row?.referenced_column || '').trim()).filter(Boolean),
      updateRule: String(rows[0]?.update_rule || '').trim().toUpperCase(),
      deleteRule: String(rows[0]?.delete_rule || '').trim().toUpperCase(),
      checkClause: String(rows[0]?.check_clause || '').trim()
    }
  })
}

export function renderTableMarkdown(detail: TableDetail, dbType: string): string {
  const table: DbTable = detail?.table ?? ({} as DbTable)
  const columns: DbColumn[] = Array.isArray(detail?.columns) ? detail.columns : []
  const indexes: DbIndex[] = Array.isArray(detail?.indexes) ? detail.indexes : []
  const constraints: DbConstraint[] = Array.isArray(detail?.constraints) ? detail.constraints : []
  const indexGroups = groupIndexRows(indexes)

  const lines: string[] = [`## ${tableTitle(table)}`]
  if (detail.checksSupported === false) lines.push('', '> 当前数据库版本不提供检查约束元数据。')
  if (detail.warnings?.length) lines.push('', ...detail.warnings.map((warning) => `> 元数据提示：${cell(warning)}`))

  const summary = [
    `Schema: ${String(table.table_schema || '—')}`,
    `引擎: ${String(table.engine || '—')}`,
    `排序规则: ${String(table.table_collation || '—')}`,
    `字段数: ${columns.length || table.column_count || 0}`
  ]
  lines.push('', summary.join(' · '))

  lines.push('', '### 字段', '')
  lines.push('| # | 字段 | 类型 | 可空 | 默认 | 索引 | 说明 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  columns.forEach((column, position) => {
    const ordinal = Number(column?.ordinal_position) > 0 ? Number(column.ordinal_position) : position + 1
    const columnName = String(column?.column_name || '')
    const fallbackType = String(column?.column_type || column?.data_type || '')
    const defaultValue = hasText(column?.column_default) ? String(column?.column_default) : '—'
    const cells = [
      ordinal,
      columnName,
      fallbackType,
      String(column?.is_nullable || ''),
      defaultValue,
      columnIndexChips(columnName, indexGroups),
      String(column?.column_comment || '')
    ]
    lines.push(`| ${cells.map((value) => cell(value)).join(' | ')} |`)
  })

  if (indexGroups.length) {
    lines.push('', '### 索引', '')
    for (const group of indexGroups) {
      const parts = [
        `**${group.name}**（${databaseIndexKindLabel(group.first)}）`,
        `列: ${group.columns.join(', ')}`,
        `算法: ${databaseIndexAlgorithm(group.first)}`
      ]
      lines.push(`- ${parts.join(' · ')}`)
    }
  }

  const constraintGroups = groupConstraintRows(constraints).filter(
    (constraint) =>
      (constraint.type === 'FOREIGN KEY' && constraint.columns.length) ||
      (constraint.type === 'CHECK' && constraint.checkClause)
  )
  if (constraintGroups.length) {
    lines.push('', '### 约束', '')
    for (const constraint of constraintGroups) {
      if (constraint.type === 'FOREIGN KEY') {
        const referencedTable = constraint.referencedSchema
          ? `${constraint.referencedSchema}.${constraint.referencedTable}`
          : constraint.referencedTable
        let constraintLine = `- **${constraint.name}**（FOREIGN KEY）: (${constraint.columns.join(', ')}) → ${referencedTable}(${constraint.referencedColumns.join(', ')})`
        if (constraint.updateRule) {
          constraintLine += ` ON UPDATE ${constraint.updateRule}`
        }
        if (constraint.deleteRule) {
          constraintLine += ` ON DELETE ${constraint.deleteRule}`
        }
        lines.push(constraintLine)
      } else {
        lines.push(`- **${constraint.name}**（CHECK）: ${constraint.checkClause}`)
      }
    }
  }

  // 栅栏用四反引号：SQL（注释等）里可能出现 ``` ，三反引号栅栏会被打断
  lines.push('', '### 建表 SQL', '', '````sql')
  lines.push(createTableSql({ table, columns, indexes, constraints }, dbType))
  lines.push('````')

  return lines.join('\n')
}

export function renderSchemaMarkdown(title: string, details: TableDetail[], dbType: string): string {
  const list = Array.isArray(details) ? details : []
  const generatedDate = dateStamp()

  const header = [`# ${String(title ?? '').trim()} 数据字典`, '', `生成时间：${generatedDate}`]
  const blocks: string[] = [header.join('\n')]

  if (list.length) {
    const toc = list.map((detail) => {
      const heading = tableTitle(detail?.table ?? ({} as DbTable))
      return `- [${heading}](#${anchorOf(heading)})`
    })
    blocks.push(['## 目录', ...toc].join('\n'))
  }

  for (const detail of list) {
    blocks.push(renderTableMarkdown(detail, dbType))
  }

  return `${blocks.join('\n\n')}\n`
}
