import { describe, expect, it } from 'vitest'
import { splitHighlight } from './highlight'

describe('splitHighlight', () => {
  it('按命中切分文本', () => {
    expect(splitHighlight('订单表', /订单/)).toEqual([
      { text: '订单', hit: true },
      { text: '表', hit: false }
    ])
  })

  it('regex 为 null 时返回整段不命中', () => {
    expect(splitHighlight('abc', null)).toEqual([{ text: 'abc', hit: false }])
  })

  it('命中开头与结尾', () => {
    expect(splitHighlight('Xabc', /X/)).toEqual([
      { text: 'X', hit: true },
      { text: 'abc', hit: false }
    ])
    expect(splitHighlight('abcX', /X/)).toEqual([
      { text: 'abc', hit: false },
      { text: 'X', hit: true }
    ])
    expect(splitHighlight('X', /X/)).toEqual([{ text: 'X', hit: true }])
  })

  it('连续命中互不粘连', () => {
    expect(splitHighlight('XX', /X/)).toEqual([
      { text: 'X', hit: true },
      { text: 'X', hit: true }
    ])
    expect(splitHighlight('aXbXc', /X/g)).toEqual([
      { text: 'a', hit: false },
      { text: 'X', hit: true },
      { text: 'b', hit: false },
      { text: 'X', hit: true },
      { text: 'c', hit: false }
    ])
  })

  it('零宽匹配不产生命中片段', () => {
    expect(splitHighlight('abc', /x*/)).toEqual([{ text: 'abc', hit: false }])
  })

  it('空文本返回整段不命中', () => {
    expect(splitHighlight('', /X/)).toEqual([{ text: '', hit: false }])
    expect(splitHighlight('', null)).toEqual([{ text: '', hit: false }])
  })
})
