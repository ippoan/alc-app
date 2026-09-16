import { describe, it, expect } from 'vitest'
import { cardKindOf } from '~/utils/card-kind'

describe('card-kind', () => {
  it('license は license', () => {
    expect(cardKindOf('license')).toBe('license')
  })

  it('felica_idm は other', () => {
    expect(cardKindOf('felica_idm')).toBe('other')
  })

  it('nfca_uid は other', () => {
    expect(cardKindOf('nfca_uid')).toBe('other')
  })

  it('null は unknown (「その他」に倒さない)', () => {
    expect(cardKindOf(null)).toBe('unknown')
  })

  it('undefined (サーバがまだ card_kind を返さない間) も unknown', () => {
    expect(cardKindOf(undefined)).toBe('unknown')
  })

  it('未知の文字列も unknown', () => {
    expect(cardKindOf('something_else')).toBe('unknown')
  })
})
