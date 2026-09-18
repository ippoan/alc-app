import { describe, it, expect, beforeEach } from 'vitest'
import { ref, readonly, computed } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import ManualMedicalInput from '~/components/ManualMedicalInput.vue'
import type { SubmitMedicalData } from '~/types'

/**
 * この端末で血圧を使うか (Refs ippoan/alc-app#347)。判定の中身は
 * `useBloodPressureSetting.test.ts` が見る — ここは**出るか / 出ないか**だけ。
 */
const showBpUi = ref(false)
mockNuxtImport('useBpUiEnabled', () => () => ({
  bpUiState: computed(() => (showBpUi.value ? 'show' : 'unused')),
  showBpUi: readonly(showBpUi),
}))

describe('ManualMedicalInput — 血圧欄は端末設定で出し分ける (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    showBpUi.value = false
  })

  it('初期値は空で、触らなければ値を送らない', async () => {
    showBpUi.value = true
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
    showBpUi.value = true
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

  it('★ 署名でボンド済みと分かった端末 (showBpUi=true) なら血圧欄を出す (Refs #322 / #347)', async () => {
    showBpUi.value = true
    const wrapper = await mountSuspended(ManualMedicalInput)

    expect(wrapper.text()).toContain('収縮期血圧')
    expect(wrapper.text()).toContain('拡張期血圧')

    wrapper.unmount()
  })

  it('スキップは skip を投げる', async () => {
    const wrapper = await mountSuspended(ManualMedicalInput)
    const skipBtn = wrapper.findAll('button').find(b => b.text() === 'スキップ')
    await skipBtn!.trigger('click')
    expect(wrapper.emitted('skip')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('ManualMedicalInput — allowSkip prop (既定 true。自動点呼の体温・血圧ステップだけ false、Refs ippoan/alc-app#322)', () => {
  beforeEach(() => {
    showBpUi.value = false
  })

  it('未指定 (既定 true): スキップボタンを出す', async () => {
    const wrapper = await mountSuspended(ManualMedicalInput)
    expect(wrapper.findAll('button').find(b => b.text() === 'スキップ')).toBeTruthy()
    wrapper.unmount()
  })

  it('allowSkip=false: スキップボタンを出さない (送信だけ)', async () => {
    const wrapper = await mountSuspended(ManualMedicalInput, { props: { allowSkip: false } })
    expect(wrapper.findAll('button').find(b => b.text() === 'スキップ')).toBeFalsy()
    expect(wrapper.findAll('button').find(b => b.text() === '送信')).toBeTruthy()
    wrapper.unmount()
  })
})
