// 展示层机器标识遮蔽：宿主可能把连接 ID（uuid / ULID / nanoid / ObjectId 等自动生成标识）
// 塞进 name / database 展示位，这类值对用户毫无信息量且观感差，一律不直接展示。
// 判定按「机器生成特征」而非单一 uuid 形状——人类可读名（含中文/空格/纯小写分隔词/短名）不误伤。

// 仅可见 ASCII 且不含空格（中文、带空格的名称一定是人类可读的）
const isCompactAscii = (v: string): boolean => /^[\x21-\x7e]+$/.test(v)
const hasLower = /[a-z]/
const hasUpper = /[A-Z]/
const hasDigit = /[0-9]/

export const looksLikeUuid = (value: string): boolean => {
  if (value.length < 16 || !isCompactAscii(value)) return false
  // 标准 uuid / 32 位 hex（连字符外的字符全为十六进制）
  if (/^[0-9a-f-]+$/i.test(value) && /[0-9a-f]/i.test(value)) return true
  // 无分隔符的长字母数字串：ULID(26)/nanoid 纯字母数字形态(21+)/ObjectId(24)/hex(32)
  if (/^[0-9A-Za-z]+$/.test(value) && hasUpper.test(value) && hasDigit.test(value)) return true
  // nanoid 常见形态（字母表含 - _）：同串内混合大小写 + 数字，人类命名几乎不会这样
  return hasLower.test(value) && hasUpper.test(value) && hasDigit.test(value)
}

export const displayValue = (value: string | null | undefined): string => {
  const v = value ?? ''
  return v !== '' && !looksLikeUuid(v) ? v : ''
}

// 自由文本（错误消息等）中内嵌的机器标识替换为省略号：
// 先替换标准 uuid，再兜底替换 20+ 位的无分隔符长 token。
export const maskUuids = (text: string): string =>
  text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '…')
    .replace(/\b[0-9A-Za-z]{20,}\b/g, (value) => looksLikeUuid(value) ? '…' : value)
