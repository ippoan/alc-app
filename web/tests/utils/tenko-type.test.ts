import { describe, it, expect } from 'vitest'
import { tenkoMethodLabel, tenkoTypeLabel } from '~/utils/tenko-type'

describe('tenko-type', () => {
  it('pre_operation は業務前', () => {
    expect(tenkoTypeLabel('pre_operation')).toBe('業務前')
  })

  it('post_operation は業務後', () => {
    expect(tenkoTypeLabel('post_operation')).toBe('業務後')
  })

  it('normal は通常', () => {
    expect(tenkoTypeLabel('normal')).toBe('通常')
  })

  it('未知の値・null・undefined は —', () => {
    expect(tenkoTypeLabel('unknown')).toBe('—')
    expect(tenkoTypeLabel(null)).toBe('—')
    expect(tenkoTypeLabel(undefined)).toBe('—')
  })
})

describe('tenkoMethodLabel', () => {
  it('記録の方法をそのまま出す (通常・遠隔・自動・IT)', () => {
    expect(tenkoMethodLabel('通常点呼')).toBe('通常点呼')
    expect(tenkoMethodLabel('遠隔点呼')).toBe('遠隔点呼')
    expect(tenkoMethodLabel('自動点呼', 'in_person')).toBe('自動点呼')
    expect(tenkoMethodLabel('IT点呼', 'it')).toBe('IT点呼')
    expect(tenkoMethodLabel('IT点呼', null)).toBe('IT点呼')
  })

  it('IT点呼 を対面で確認して確定した回は対面点呼 (CSV と同じ)', () => {
    expect(tenkoMethodLabel('IT点呼', 'in_person')).toBe('対面点呼')
  })

  it('値が無ければ —', () => {
    expect(tenkoMethodLabel(undefined)).toBe('—')
    expect(tenkoMethodLabel(null)).toBe('—')
    expect(tenkoMethodLabel('')).toBe('—')
  })
})
