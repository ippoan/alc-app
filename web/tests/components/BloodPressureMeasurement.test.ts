import type { BpUiState } from '~/composables/useBloodPressureSetting'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import BloodPressureMeasurement from '~/components/BloodPressureMeasurement.vue'

// 血圧だけを測る端末の画面 (Refs ippoan/alc-app-s3#135)。
// カードをかざす → 顔認証 → 血圧を測る → 完了 だけを行い、**点呼の記録は作らない**。
// 従業員はすべて合成値 (実在の乗務員名・カード番号は書かない)

const employee = ref<{ id: string, name: string, face_approval_status?: string }>({
  id: 'emp-test-1',
  name: 'テスト太郎',
  face_approval_status: 'approved',
})

// vi.mock はファイル先頭へ巻き上がるので、factory から触る mock は vi.hoisted で作る。
// 他の export (useAuth が使う rePairDevice 等) は本物のまま残す
const { startMeasurementMock, updateMeasurementMock, saveMeasurementMock, startTenkoSessionMock, getEmployeeByNfcIdMock }
  = vi.hoisted(() => ({
    startMeasurementMock: vi.fn(),
    updateMeasurementMock: vi.fn(),
    saveMeasurementMock: vi.fn(),
    startTenkoSessionMock: vi.fn(),
    getEmployeeByNfcIdMock: vi.fn(),
  }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployeeByNfcId: getEmployeeByNfcIdMock,
  startMeasurement: startMeasurementMock,
  updateMeasurement: updateMeasurementMock,
  saveMeasurement: saveMeasurementMock,
  startTenkoSession: startTenkoSessionMock,
}))

// 「この端末で血圧を使うか」の判定は **`useBpUiEnabled` の 1 か所** (Refs ippoan/alc-app#353)。
// 生の `bpEnabled` (= サーバの `devices.bp_enabled`) は、`devices` に行を持たない
// 測定台では**永久に false** なので、画面はこちらを見る
const bpUiState = ref<BpUiState>('show')
mockNuxtImport('useBpUiEnabled', () => () => ({
  bpUiState,
  showBpUi: computed(() => bpUiState.value === 'show'),
}))

const latestBloodPressure = ref<{ systolic: number, diastolic: number, pulse?: number, measuredAt: Date } | null>(null)
mockNuxtImport('useBleGateway', () => () => ({ latestBloodPressure }))

const NfcStatusStub = { name: 'NfcStatus', template: '<div class="nfc-stub" />', emits: ['read'] }
const FaceAuthStub = { name: 'FaceAuth', template: '<div class="face-stub" />', emits: ['result'] }
const BleStatusStub = { name: 'BleStatus', template: '<div class="ble-stub" />', emits: ['next', 'skip'] }

function mountBp() {
  return mountSuspended(BloodPressureMeasurement, {
    shallow: true,
    global: { stubs: { NfcStatus: NfcStatusStub, FaceAuth: FaceAuthStub, BleStatus: BleStatusStub } },
  })
}

/** 非同期の乗務員解決・保存を流し切る */
async function flush(wrapper: Awaited<ReturnType<typeof mountBp>>) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()
}

async function tapCard(wrapper: Awaited<ReturnType<typeof mountBp>>, nfcId = 'test-card-0001') {
  await wrapper.findComponent(NfcStatusStub).vm.$emit('read', nfcId)
  await flush(wrapper)
}

describe('BloodPressureMeasurement (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    bpUiState.value = 'show'
    latestBloodPressure.value = null
    employee.value = { id: 'emp-test-1', name: 'テスト太郎', face_approval_status: 'approved' }
    getEmployeeByNfcIdMock.mockReset()
    getEmployeeByNfcIdMock.mockImplementation(async () => employee.value)
    startMeasurementMock.mockReset()
    startMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    updateMeasurementMock.mockReset()
    updateMeasurementMock.mockResolvedValue({ id: 'meas-test-1' })
    saveMeasurementMock.mockClear()
    startTenkoSessionMock.mockClear()
  })

  it('BloodPressureMeasurement — カード → 顔認証 → 血圧 の順に進む', async () => {
    const wrapper = await mountBp()

    // 1. カードをかざす段
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)

    // 2. カードを読むと顔認証へ
    await tapCard(wrapper)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(true)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)
    expect(wrapper.text()).toContain('テスト太郎')

    // 3. 顔が通ると血圧測定へ
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 顔が未登録ならスキップできる', async () => {
    employee.value = { id: 'emp-test-2', name: 'テスト次郎', face_approval_status: 'none' }
    const wrapper = await mountBp()
    await tapCard(wrapper)

    // 未登録である事実と、スキップの口が出る (顔認証そのものは出さない)
    expect(wrapper.text()).toContain('顔データが未登録です')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    const skipBtn = wrapper.findAll('button').find(b => b.text() === '顔認証をスキップして進む')
    expect(skipBtn).toBeTruthy()

    // スキップすると血圧測定へ進む
    await skipBtn!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent(BleStatusStub).exists()).toBe(true)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 顔が却下なら進めない', async () => {
    employee.value = { id: 'emp-test-3', name: 'テスト三郎', face_approval_status: 'rejected' }
    const wrapper = await mountBp()
    await tapCard(wrapper)

    // 却下は登録済みなので弾く — 顔認証の段にもスキップの口にも行かない
    expect(wrapper.text()).toContain('却下')
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(true)
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
    expect(wrapper.findAll('button').find(b => b.text() === '顔認証をスキップして進む')).toBeFalsy()

    // 審査中 (pending) も同じく弾く
    employee.value = { id: 'emp-test-4', name: 'テスト四郎', face_approval_status: 'pending' }
    await tapCard(wrapper)
    expect(wrapper.text()).toContain('承認待ち')
    expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 血圧が測れたら保存する', async () => {
    const wrapper = await mountBp()
    await tapCard(wrapper)
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()

    const measuredAt = new Date('2026-09-16T01:02:03.000Z')
    latestBloodPressure.value = { systolic: 124, diastolic: 78, pulse: 66, measuredAt }
    await flush(wrapper)

    expect(startMeasurementMock).toHaveBeenCalledWith('emp-test-1')
    expect(updateMeasurementMock).toHaveBeenCalledTimes(1)
    const [id, body] = updateMeasurementMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('meas-test-1')
    expect(body).toMatchObject({
      status: 'completed',
      systolic: 124,
      diastolic: 78,
      pulse: 66,
      medical_measured_at: measuredAt.toISOString(),
    })

    // 完了の段で測った値を見せる
    expect(wrapper.text()).toContain('測定完了')
    expect(wrapper.text()).toContain('124')
    expect(wrapper.text()).toContain('78')

    wrapper.unmount()
  })

  it.each<BpUiState>(['unused', 'unavailable', 'unregistered'])(
    'BloodPressureMeasurement — %s の端末では「血圧計が見つかりません」の案内だけを出す',
    async (state) => {
      bpUiState.value = state
      const wrapper = await mountBp()

      expect(wrapper.text()).toContain('血圧計が見つかりません')
      // 測る口はどれも出さない
      expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)
      expect(wrapper.findComponent(FaceAuthStub).exists()).toBe(false)
      expect(wrapper.findComponent(BleStatusStub).exists()).toBe(false)

      wrapper.unmount()
    },
  )

  it('BloodPressureMeasurement — checking の間は待つ (「使わない設定」に倒さない)', async () => {
    // ★ ここで倒すと、署名をまだ取りに行っていない起動直後に**必ず**詰まる
    bpUiState.value = 'checking'
    const wrapper = await mountBp()

    expect(wrapper.text()).toContain('血圧計を確認しています')
    expect(wrapper.text()).not.toContain('血圧計が見つかりません')
    // まだ測らせない (確認が済むまで)
    expect(wrapper.findComponent(NfcStatusStub).exists()).toBe(false)

    wrapper.unmount()
  })

  it('BloodPressureMeasurement — 生の bpEnabled は見ない (測定台では永久に false のため)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, '../../app/components/BloodPressureMeasurement.vue'),
      'utf-8',
    )
    // 判定は useBpUiEnabled の 1 か所に寄せる (doc コメントの言及は残るので、呼び出しの形を見る)
    expect(src).not.toMatch(/useBloodPressureSetting\s*\(/)
    expect(src).toMatch(/useBpUiEnabled\s*\(/)
  })

  it('BloodPressureMeasurement — 点呼の記録を作らない', async () => {
    const wrapper = await mountBp()
    await tapCard(wrapper)
    await wrapper.findComponent(FaceAuthStub).vm.$emit('result', { verified: true, similarity: 0.9 })
    await wrapper.vm.$nextTick()

    latestBloodPressure.value = { systolic: 130, diastolic: 84, measuredAt: new Date('2026-09-16T02:00:00.000Z') }
    await flush(wrapper)

    // 点呼のセッションを作る口も、record_as_tenko 固定の口も通らない
    expect(startTenkoSessionMock).not.toHaveBeenCalled()
    expect(saveMeasurementMock).not.toHaveBeenCalled()
    // 保存の本文に点呼の印が入らない (入ると rust-alc-api が点呼の記録を作る)
    const [, body] = updateMeasurementMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(body).not.toHaveProperty('record_as_tenko')
    expect(body).not.toHaveProperty('tenko_type')

    // 点呼のセッション前提の口を呼んでいないこと自体を固定する
    // (doc コメントは「使わない」と書いているので、呼び出しの形だけを見る)
    const src = readFileSync(
      resolve(import.meta.dirname!, '../../app/components/BloodPressureMeasurement.vue'),
      'utf-8',
    )
    expect(src).not.toMatch(/useTenkoKiosk\s*\(/)
    expect(src).not.toMatch(/\bsaveMeasurement\s*\(/)

    wrapper.unmount()
  })
})
