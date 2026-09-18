import { describe, it, expect, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ManualMedicalInput from '~/components/ManualMedicalInput.vue'
import type { SubmitMedicalData } from '~/types'

// この端末で血圧計を使うか (端末設定の 1 系統)。受け口は useBloodPressureSetting だけ。
const bpEnabled = ref(false)
mockNuxtImport('useBloodPressureSetting', () => () => ({
  bpEnabled: readonly(bpEnabled),
  setBpEnabled: (v: boolean) => { bpEnabled.value = v },
}))

// 未登録端末でも血圧計が在れば手入力欄を出す (Refs ippoan/alc-app#322)
const hasBpHardware = ref(false)
mockNuxtImport('useBleGateway', () => () => ({
  hasBpHardware: readonly(hasBpHardware),
}))

describe('ManualMedicalInput — 血圧欄は端末設定で出し分ける (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    bpEnabled.value = false
    hasBpHardware.value = false
  })

  it('初期値は空で、触らなければ値を送らない', async () => {
    bpEnabled.value = true
    const wrapper = await mountSuspended(ManualMedicalInput)

    // 欄は出るが空 (既定値 120/80 を置かない)
    expect(wrapper.text()).toContain('収縮期血圧')
    expect(wrapper.text()).toContain('拡張期血圧')
    const values = wrapper.findAll('input').map(i => (i.element as HTMLInputElement).value)
    expect(values).toContain('')

    const submitBtn = wrapper.findAll('button').find(b => b.text() === '送信')
    await submitBtn!.trigger('click')

    const data = wrapper.emitted('submit')![0]![0] as SubmitMedicalData
    // 触っていない初期値が「測れた値」として通らないこと
    expect(data.systolic).toBeUndefined()
    expect(data.diastolic).toBeUndefined()

    wrapper.unmount()
  })

  it('血圧を使う端末で入力した値はそのまま送られる', async () => {
    bpEnabled.value = true
    const wrapper = await mountSuspended(ManualMedicalInput)

    const inputs = wrapper.findAll('input')
    await inputs[2]!.setValue('118')
    await inputs[3]!.setValue('76')

    const submitBtn = wrapper.findAll('button').find(b => b.text() === '送信')
    await submitBtn!.trigger('click')

    const data = wrapper.emitted('submit')![0]![0] as SubmitMedicalData
    expect(data.systolic).toBe(118)
    expect(data.diastolic).toBe(76)

    wrapper.unmount()
  })

  it('血圧を使わない端末では血圧欄が無く、systolic/diastolic を送らない', async () => {
    const wrapper = await mountSuspended(ManualMedicalInput)

    expect(wrapper.text()).not.toContain('収縮期血圧')
    expect(wrapper.text()).not.toContain('拡張期血圧')

    const submitBtn = wrapper.findAll('button').find(b => b.text() === '送信')
    await submitBtn!.trigger('click')

    const data = wrapper.emitted('submit')![0]![0] as SubmitMedicalData
    expect(data.systolic).toBeUndefined()
    expect(data.diastolic).toBeUndefined()
    // 体温・脈拍は影響を受けない
    expect(data.temperature).toBe(36.5)
    expect(data.pulse).toBe(70)

    wrapper.unmount()
  })

  it('スキップは skip を投げる', async () => {
    const wrapper = await mountSuspended(ManualMedicalInput)
    const skipBtn = wrapper.findAll('button').find(b => b.text() === 'スキップ')
    await skipBtn!.trigger('click')
    expect(wrapper.emitted('skip')).toHaveLength(1)
    wrapper.unmount()
  })

  it('bpEnabled=false でも hasBpHardware=true なら血圧欄を出す (未登録端末でも値を出せる、Refs #322)', async () => {
    hasBpHardware.value = true
    const wrapper = await mountSuspended(ManualMedicalInput)

    expect(wrapper.text()).toContain('収縮期血圧')
    expect(wrapper.text()).toContain('拡張期血圧')

    wrapper.unmount()
  })
})
