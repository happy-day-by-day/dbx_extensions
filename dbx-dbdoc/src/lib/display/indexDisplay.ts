// 索引展示纯函数：由 data-watcher databaseIndexDisplay.mjs 原样移植
// （判定规则/中文文案不变），参数类型改为统一实体 DbIndex（字段名 snake_case 与源一致）。
import type { DbIndex } from '../dialects/entities'

const normalizedText = (value: unknown): string => String(value ?? '').trim()

export const databaseIndexKind = (index: DbIndex = {} as DbIndex): 'primary' | 'unique' | 'normal' => {
  const indexName = normalizedText(index.index_name)
  // 源实现兼容 ext 标记；统一实体无该字段，保留判定以维持行为一致。
  const ext = (index as { ext?: unknown }).ext
  const isPrimary = index.is_primary || ext === 'primary' || indexName.toUpperCase() === 'PRIMARY' || /_pkey$/i.test(indexName)
  if (isPrimary) {
    return 'primary'
  }
  return normalizedText(index.non_unique) === '0' ? 'unique' : 'normal'
}

export const databaseIndexKindLabel = (index: DbIndex = {} as DbIndex): string =>
  ({
    primary: '主键',
    unique: '唯一',
    normal: '普通'
  })[databaseIndexKind(index)]

export const databaseIndexAlgorithm = (index: DbIndex = {} as DbIndex): string => normalizedText(index.index_type).toUpperCase() || '—'

export const databaseIndexSequence = (index: DbIndex = {} as DbIndex): number => {
  const sequence = Number(index.seq)
  return Number.isFinite(sequence) && sequence > 0 ? sequence : 1
}

export const databaseIndexDirection = (index: DbIndex = {} as DbIndex): string => {
  const direction = normalizedText(index.collation).toUpperCase()
  if (direction === 'A' || direction === '0') {
    return 'ASC'
  }
  if (direction === 'D' || direction === '1') {
    return 'DESC'
  }
  return direction === 'ASC' || direction === 'DESC' ? direction : ''
}

export const databaseIndexDisplayTitle = (index: DbIndex = {} as DbIndex): string => {
  const direction = databaseIndexDirection(index)
  return [
    normalizedText(index.index_name) || '未命名索引',
    databaseIndexKindLabel(index),
    databaseIndexAlgorithm(index),
    `第 ${databaseIndexSequence(index)} 位`,
    direction
  ]
    .filter(Boolean)
    .join(' · ')
}
