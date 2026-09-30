import { describe, expect, it } from 'vitest'
import { displayValue, looksLikeUuid, maskUuids } from './masking'

describe('looksLikeUuid', () => {
  it('识别标准 UUID（大小写均可）', () => {
    expect(looksLikeUuid('a3f9c2e1-1111-2222-3333-444455556666')).toBe(true)
    expect(looksLikeUuid('A3F9C2E1-1111-2222-3333-444455556666')).toBe(true)
  })
  it('识别无连字符长十六进制串', () => {
    expect(looksLikeUuid('a3f9c2e1111122223333444455556666')).toBe(true)
  })
  it('识别 ULID / ObjectId / 纯字母数字 nanoid（非十六进制字母）', () => {
    // ULID 26 位 Crockford base32（含 g-z 字母）
    expect(looksLikeUuid('01J8X9H2K5M7Q3R9T5V2W4XYZ6')).toBe(true)
    // ObjectId 24 位 hex 已覆盖；纯字母数字 nanoid 形态
    expect(looksLikeUuid('V1StGXR8Z5jdHi6BmyTqPz')).toBe(true)
  })
  it('识别含 -_ 分隔的 nanoid 形态（混合大小写 + 数字）', () => {
    expect(looksLikeUuid('V1StGXR8_Z5jdHi6B-myTq')).toBe(true)
  })
  it('普通名称与短十六进制不误判', () => {
    expect(looksLikeUuid('prod-mysql')).toBe(false)
    expect(looksLikeUuid('order-service-db-prod-2')).toBe(false)
    expect(looksLikeUuid('订单库')).toBe(false)
    expect(looksLikeUuid('Prod PG 2024')).toBe(false)
    expect(looksLikeUuid('abc123')).toBe(false)
    expect(looksLikeUuid('PostgreSQL')).toBe(false)
    expect(looksLikeUuid('utf8mb4_0900_ai_ci')).toBe(false)
    expect(looksLikeUuid('INFORMATION_SCHEMA')).toBe(false)
    expect(looksLikeUuid('')).toBe(false)
    expect(looksLikeUuid('businessdatabases')).toBe(false)
    expect(displayValue('customerinformationwarehouse')).toBe('customerinformationwarehouse')
  })
})

describe('displayValue', () => {
  it('正常值透传，机器标识/空值归空串', () => {
    expect(displayValue('订单库')).toBe('订单库')
    expect(displayValue('appdb')).toBe('appdb')
    expect(displayValue('a3f9c2e1-1111-2222-3333-444455556666')).toBe('')
    expect(displayValue('01J8X9H2K5M7Q3R9T5V2W4XYZ6')).toBe('')
    expect(displayValue('')).toBe('')
    expect(displayValue(null)).toBe('')
    expect(displayValue(undefined)).toBe('')
  })
})

describe('maskUuids', () => {
  it('把消息中的标准 UUID 替换为省略号', () => {
    expect(maskUuids('连接 a3f9c2e1-1111-2222-3333-444455556666 查询失败')).toBe('连接 … 查询失败')
  })
  it('把消息中的长无分隔符 token（hex/ULID/nanoid）替换为省略号', () => {
    expect(maskUuids('conn 01J8X9H2K5M7Q3R9T5V2W4XYZ6 denied')).toBe('conn … denied')
  })
  it('不含机器标识的文本原样返回（含下划线标识符/中文）', () => {
    expect(maskUuids('查询超时（65 秒）')).toBe('查询超时（65 秒）')
    expect(maskUuids('PLUGIN_DATA_ACCESS_NOT_GRANTED: 拒绝')).toBe('PLUGIN_DATA_ACCESS_NOT_GRANTED: 拒绝')
  })
})
