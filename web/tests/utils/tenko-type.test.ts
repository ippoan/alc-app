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

import { isBpInPersonSession, isInPersonTenkoMethod, isResumableInAutoTab } from '~/utils/tenko-type'

describe('isBpInPersonSession / isInPersonTenkoMethod', () => {
  const base = { schedule_id: 's', tenko_type: 'pre_operation', tenko_method: '対面点呼', remote_escalation_reason: '血圧の記録が 10 日分に満たない (いま 2 日分) ため対面点呼' }
  it('対面の区分は通常点呼と対面点呼', () => {
    expect(isInPersonTenkoMethod('通常点呼')).toBe(true)
    expect(isInPersonTenkoMethod('対面点呼')).toBe(true)
    expect(isInPersonTenkoMethod('遠隔点呼')).toBe(false)
    expect(isInPersonTenkoMethod(null)).toBe(false)
  })
  it('予定・業務前・対面・血圧の理由が揃ったものだけ true', () => {
    expect(isBpInPersonSession(base)).toBe(true)
    expect(isBpInPersonSession({ ...base, schedule_id: null })).toBe(false)
    expect(isBpInPersonSession({ ...base, tenko_type: 'post_operation' })).toBe(false)
    expect(isBpInPersonSession({ ...base, tenko_method: '遠隔点呼' })).toBe(false)
    expect(isBpInPersonSession({ ...base, remote_escalation_reason: null })).toBe(false)
  })
})

describe('isResumableInAutoTab (自動点呼のタブの再開の候補)', () => {
  const inPerson = { schedule_id: 's', tenko_type: 'pre_operation', tenko_method: '通常点呼', remote_escalation_reason: '血圧の記録が 10 日分に満たない (いま 2 日分) ため対面点呼' }
  it('自動点呼・方法の無い古い行・血圧の記録不足で対面点呼にしたものだけ', () => {
    expect(isResumableInAutoTab({ tenko_method: '自動点呼' })).toBe(true)
    expect(isResumableInAutoTab({})).toBe(true)
    expect(isResumableInAutoTab(inPerson)).toBe(true)
    expect(isResumableInAutoTab({ tenko_method: '遠隔点呼' })).toBe(false)
    expect(isResumableInAutoTab({ tenko_method: '通常点呼' })).toBe(false)
    expect(isResumableInAutoTab({ tenko_method: 'IT点呼' })).toBe(false)
  })
})
