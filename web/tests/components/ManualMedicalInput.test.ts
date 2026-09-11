import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { SubmitMedicalData } from '~/types'

// SHOW_BLOOD_PRESSURE は定数エクスポートなので、値ごとに vi.doMock + resetModules で
// component を取り直す (モジュールスコープ状態のテスト分離パターンに準拠)。
describe('ManualMedicalInput — SHOW_BLOOD_PRESSURE の出し分け (Refs #238)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('SHOW_BLOOD_PRESSURE=false: 血圧欄が無く、送信データの systolic/diastolic が無い (null 送信、偽の 120/80 を防ぐ)', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: false }))
    const { default: ManualMedicalInput } = await import('~/components/ManualMedicalInput.vue')
    const wrapper = await mountSuspended(ManualMedicalInput)

    expect(wrapper.text()).not.toContain('収縮期血圧')
    expect(wrapper.text()).not.toContain('拡張期血圧')

    const submitBtn = wrapper.findAll('button').find(b => b.text() === '送信')
    await submitBtn!.trigger('click')

    const emitted = wrapper.emitted('submit')
    expect(emitted).toBeTruthy()
    const data = emitted![0]![0] as SubmitMedicalData
    expect(data.systolic).toBeUndefined()
    expect(data.diastolic).toBeUndefined()
    // 体温・脈拍は影響を受けない
    expect(data.temperature).toBe(36.5)
    expect(data.pulse).toBe(70)

    wrapper.unmount()
  })

  it('SHOW_BLOOD_PRESSURE=true: 血圧欄があり、従来どおり既定値 120/80 が送られる', async () => {
    vi.doMock('~/utils/medical-inputs', () => ({ SHOW_BLOOD_PRESSURE: true }))
    const { default: ManualMedicalInput } = await import('~/components/ManualMedicalInput.vue')
    const wrapper = await mountSuspended(ManualMedicalInput)

    expect(wrapper.text()).toContain('収縮期血圧')
    expect(wrapper.text()).toContain('拡張期血圧')

    const submitBtn = wrapper.findAll('button').find(b => b.text() === '送信')
    await submitBtn!.trigger('click')

    const emitted = wrapper.emitted('submit')
    const data = emitted![0]![0] as SubmitMedicalData
    expect(data.systolic).toBe(120)
    expect(data.diastolic).toBe(80)

    wrapper.unmount()
  })
})
