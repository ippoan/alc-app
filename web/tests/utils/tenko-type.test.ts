import { describe, it, expect } from 'vitest'
import { tenkoTypeLabel } from '~/utils/tenko-type'

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
