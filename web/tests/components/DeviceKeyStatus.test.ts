// 管理者の画面のタブ「端末の鍵の状態」(Refs ippoan/alc-cam#2、設計書 §7.2)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DeviceKeyStatus from '~/components/DeviceKeyStatus.vue'
import AdminDashboard from '~/components/AdminDashboard.vue'
import { resetDeviceNames } from '~/composables/useDeviceNames'
import type { DeviceKeyStatus as Status } from '~/utils/device-key-status'

const api = vi.hoisted(() => ({
  getDeviceKeyStatus: vi.fn(),
  listDeviceLabels: vi.fn(),
  listCamHostKeys: vi.fn(),
  listFirmwareDevices: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const C0 = { hub_measurements_via_key: 0, hub_measurements_hub_id: 0, measurements: 0, vein_enroll: 0, timecard: 0 }
const STATUS: Status = {
  days: 7,
  devices: [
    { device_id: 'alarm:fp-1', kind: 'machine_key', counts: { ...C0, hub_measurements_via_key: 5, hub_measurements_hub_id: 2, measurements: 3 }, last_at: '2026-10-23T12:00:00.000+09:00', is_dev: false },
    { device_id: 'hub-1', kind: 'hub_unlinked', counts: { ...C0, hub_measurements_hub_id: 4 }, last_at: '2026-10-22T08:00:00.000+09:00', is_dev: true },
    { device_id: 'cred-1', kind: 'credential', counts: { ...C0, timecard: 7 }, last_at: null },
    { device_id: 'browser', kind: 'browser', counts: { ...C0, timecard: 1 }, last_at: '2026-10-21T00:00:00.000Z' },
  ],
  unattributed: { measurements: 6, last_at: '2026-10-23T03:00:00.000Z' },
}
const t = (id: string) => `[data-testid="device-key-status-${id}"]`
/** 期間の select から日数の option を選ぶ */
const pickDays = (w: Awaited<ReturnType<typeof mountIt>>, d: number) =>
  w.findAll(`${t('days')} option`).find(o => o.text() === `直近 ${d} 日`)!.setSelected()

async function mountIt() {
  const w = await mountSuspended(DeviceKeyStatus)
  await flushPromises()
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDeviceNames()
  api.getDeviceKeyStatus.mockResolvedValue(STATUS)
  api.listDeviceLabels.mockResolvedValue({ devices: [{ device_id: 'hub-1', label: '旧ハブ' }] })
  api.listCamHostKeys.mockResolvedValue({
    keys: [{ device_id: 'alarm:fp-1', label: '事務所の機体' }],
    names: [{ device_id: 'alarm:fp-1', label: '事務所の機体', revoked: false }],
  })
  api.listFirmwareDevices.mockResolvedValue({ devices: [] })
})

describe('DeviceKeyStatus', () => {
  it('既定は直近 7 日で取り、端末の名前 (ID は title)・鍵の種類・JST の最終時刻・件数・開発用の印を出す', async () => {
    const w = await mountIt()
    expect(api.getDeviceKeyStatus).toHaveBeenCalledWith(7)
    const rows = w.findAll(t('row'))
    expect(rows).toHaveLength(4)
    const first = rows[0]!
    expect(first.find(t('name')).text()).toBe('事務所の機体')
    expect(first.find(t('name')).attributes('title')).toBe('alarm:fp-1')
    expect(first.find(t('kind')).text()).toBe('機体の鍵')
    expect(first.find(t('last')).text()).toBe('2026-10-23 12:00:00')
    expect(first.find(t('count-hub_measurements_via_key')).text()).toBe('5')
    expect(first.find(t('count-measurements')).text()).toBe('3')
    expect(first.find(t('dev')).exists()).toBe(false)
    expect(rows[1]!.find(t('dev')).exists()).toBe(true)
    expect(rows[1]!.find(t('name')).text()).toContain('旧ハブ')
    expect(rows[2]!.find(t('last')).text()).toBe('—')
    expect(rows[3]!.find(t('last')).text()).toBe('2026-10-21 09:00:00')
  })

  it('警告 4 つ: 鍵の行の hub の ID・hub_unlinked・credential・端末 ID の無い測定', async () => {
    const w = await mountIt()
    const rows = w.findAll(t('row'))
    expect(rows[0]!.find(t('warning')).text()).toContain('鍵の証明が取れていません')
    expect(rows[0]!.find(t('warning')).text()).toContain('2 件')
    expect(rows[1]!.find(t('warning')).text()).toContain('ファームを更新')
    expect(rows[2]!.find(t('warning')).text()).toContain('機体の鍵を登録してください')
    expect(rows[3]!.find(t('warning')).exists()).toBe(false)
    expect(w.find(t('unattributed')).text()).toContain('端末の鍵の無い測定が 6 件')
    expect(w.find(t('unattributed')).text()).toContain('2026-10-23 12:00:00')
  })

  it('注記を常に出す', async () => {
    const w = await mountIt()
    expect(w.find(t('note')).text()).toBe('端末 ID を記録する仕組みを入れる前の記録は、どの端末か分かりません。')
  })

  it('端末 ID の無い測定が 0 件なら警告を出さない。端末が無ければ空の文言', async () => {
    api.getDeviceKeyStatus.mockResolvedValue({ days: 7, devices: [], unattributed: { measurements: 0, last_at: null } })
    const w = await mountIt()
    expect(w.find(t('unattributed')).exists()).toBe(false)
    expect(w.find(t('empty')).exists()).toBe(true)
    expect(w.find('table').exists()).toBe(false)
    expect(w.find(t('note')).exists()).toBe(true)
  })

  it('期間 (7/30/90 日) を選ぶと取り直す', async () => {
    const w = await mountIt()
    expect(w.findAll(`${t('days')} option`).map(o => o.text())).toEqual(['直近 7 日', '直近 30 日', '直近 90 日'])
    await pickDays(w, 90)
    await flushPromises()
    expect(api.getDeviceKeyStatus).toHaveBeenLastCalledWith(90)
  })

  it('再読み込みで取り直す', async () => {
    const w = await mountIt()
    await w.find(t('reload')).trigger('click')
    await flushPromises()
    expect(api.getDeviceKeyStatus).toHaveBeenCalledTimes(2)
  })

  it('API が失敗したらエラーを出して画面は壊さない (本文の error を取り出す。注記は残る)', async () => {
    api.getDeviceKeyStatus.mockRejectedValue(new Error('API エラー (404): {"error":"not found"}'))
    const w = await mountIt()
    expect(w.find(t('error')).text()).toBe('not found')
    expect(w.find(t('row')).exists()).toBe(false)
    expect(w.find(t('note')).exists()).toBe(true)
  })

  it('失敗の文言が読めなければ既定の文言', async () => {
    api.getDeviceKeyStatus.mockRejectedValue('x')
    const w = await mountIt()
    expect(w.find(t('error')).text()).toBe('端末の鍵の状態を取得できませんでした')
  })

  it('再取得が失敗したら前の表を消してエラーを出し、成功したらエラーを消す', async () => {
    const w = await mountIt()
    api.getDeviceKeyStatus.mockRejectedValueOnce(new Error('API エラー (500): boom'))
    await w.find(t('reload')).trigger('click')
    await flushPromises()
    expect(w.find(t('error')).exists()).toBe(true)
    expect(w.find(t('row')).exists()).toBe(false)
    await w.find(t('reload')).trigger('click')
    await flushPromises()
    expect(w.find(t('error')).exists()).toBe(false)
    expect(w.findAll(t('row'))).toHaveLength(4)
  })

  it('読み込み中は「読み込み中」を出す', async () => {
    let resolve!: (v: Status) => void
    api.getDeviceKeyStatus.mockReturnValue(new Promise((r) => { resolve = r }))
    const w = await mountSuspended(DeviceKeyStatus)
    await flushPromises()
    expect(w.find(t('loading')).exists()).toBe(true)
    resolve(STATUS)
    await flushPromises()
    expect(w.find(t('loading')).exists()).toBe(false)
  })

  it('期間を続けて変えたとき、遅れて返った古い応答で上書きしない', async () => {
    const w = await mountIt()
    let resolveOld!: (v: Status) => void
    api.getDeviceKeyStatus.mockReturnValueOnce(new Promise((r) => { resolveOld = r }))
    await pickDays(w, 30)
    api.getDeviceKeyStatus.mockResolvedValueOnce({ ...STATUS, devices: [STATUS.devices[0]!] })
    await pickDays(w, 90)
    await flushPromises()
    expect(w.findAll(t('row'))).toHaveLength(1)
    resolveOld(STATUS)
    await flushPromises()
    expect(w.findAll(t('row'))).toHaveLength(1)
  })

  it('古い応答の失敗も新しい結果を消さない', async () => {
    const w = await mountIt()
    let rejectOld!: (e: Error) => void
    api.getDeviceKeyStatus.mockReturnValueOnce(new Promise((_, rej) => { rejectOld = rej }))
    await pickDays(w, 30)
    api.getDeviceKeyStatus.mockResolvedValueOnce(STATUS)
    await pickDays(w, 90)
    await flushPromises()
    rejectOld(new Error('API エラー (500): late'))
    await flushPromises()
    expect(w.find(t('error')).exists()).toBe(false)
    expect(w.findAll(t('row'))).toHaveLength(4)
  })
})

describe('AdminDashboard — 端末の鍵の状態のタブ', () => {
  it('「端末のファーム」の隣に常に出て、押すと描画される (?tab=device_key_status でも開ける)', async () => {
    const w = await mountSuspended(AdminDashboard)
    await flushPromises()
    const labels = w.findAll('button').map(b => b.text())
    expect(labels).toContain('端末の鍵の状態')
    expect(w.findComponent(DeviceKeyStatus).exists()).toBe(false)
    await w.findAll('button').find(b => b.text() === '端末の鍵の状態')!.trigger('click')
    await flushPromises()
    expect(w.findComponent(DeviceKeyStatus).exists()).toBe(true)
    w.unmount()
    const direct = await mountSuspended(AdminDashboard, { props: { initialTab: 'device_key_status' } })
    await flushPromises()
    expect(direct.findComponent(DeviceKeyStatus).exists()).toBe(true)
    direct.unmount()
  })
})
