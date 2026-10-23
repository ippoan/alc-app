// 管理者の画面のタブ「端末の指静脈」(Refs ippoan/alc-app#436)。
// 開いたら一覧を引き、全キオスクへ合図を出す。`vein_list_updated` の合図で引き直す。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import type { VeinFleetDevice } from '~/utils/api'
import VeinFleetManager from '~/components/VeinFleetManager.vue'

const { listVeinFleet, requestVeinFleet, getEmployees } = vi.hoisted(() => ({
  listVeinFleet: vi.fn(),
  requestVeinFleet: vi.fn(),
  getEmployees: vi.fn(),
}))
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  listVeinFleet,
  requestVeinFleet,
  getEmployees,
}))

const timecardWatch = vi.hoisted(() => vi.fn())
mockNuxtImport('useTimecardWatch', () => timecardWatch)
const auth = vi.hoisted(() => ({ accessToken: { value: 'admin-jwt' } }))
mockNuxtImport('useAuth', () => () => auth)

const watchHandle = vi.hoisted(() => ({ connect: vi.fn(async () => {}), stop: vi.fn() }))
interface WatchOptions { getToken: () => unknown, onVeinListUpdated: () => void }
const watchOptions = (): WatchOptions => timecardWatch.mock.calls[0]![0] as WatchOptions

function dev(over: Partial<VeinFleetDevice> = {}): VeinFleetDevice {
  return {
    device_id: 'devaaaaa-bbbb',
    label: '事務所',
    entries: [
      { module_id: 12, employee_id: 'e2', approved: false },
      { module_id: 10, employee_id: 'e1', approved: true },
    ],
    module_users: 2,
    module_max: 100,
    reported_at_ms: Date.UTC(2026, 9, 22, 3),
    ...over,
  }
}

async function mountManager() {
  const wrapper = await mountSuspended(VeinFleetManager)
  await flushPromises()
  return wrapper
}

describe('VeinFleetManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    timecardWatch.mockReturnValue(watchHandle)
    listVeinFleet.mockResolvedValue({ devices: [dev()] })
    requestVeinFleet.mockResolvedValue({ sent: 2 })
    getEmployees.mockResolvedValue([{ id: 'e1', name: '山田' }])
  })

  it('★ 開いたら管理者の token で購読し、一覧を引いて全キオスクへ合図を出す', async () => {
    const wrapper = await mountManager()
    expect(watchHandle.connect).toHaveBeenCalledTimes(1)
    expect(watchOptions().getToken()).toBe('admin-jwt')
    expect(listVeinFleet).toHaveBeenCalledTimes(1)
    expect(requestVeinFleet).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="vein-fleet-notice"]').text()).toBe('問い合わせました (接続 2 本)。返事が来た端末から下に出ます')
  })

  it('端末ごとに ID 順で乗務員と状態を出す。名前が引けない人は id の頭', async () => {
    const wrapper = await mountManager()
    const device = wrapper.find('[data-testid="vein-fleet-device"]')
    expect(device.text()).toContain('事務所')
    expect(device.text()).toContain('2 人 (空き 89 / 91)')
    expect(device.text()).toContain('モジュール 2 人')
    const rows = wrapper.findAll('[data-testid="vein-fleet-row"]').map(r => r.text())
    expect(rows).toEqual(['10山田承認済み不明', '12(名前不明 e2)承認待ち不明'])
    expect(wrapper.find('[data-testid="vein-fleet-mismatch"]').exists()).toBe(false)
  })

  it('ラベルが無い端末は id の頭、空の端末・人数の食い違い・登録人数の無い端末', async () => {
    listVeinFleet.mockResolvedValue({
      devices: [
        dev({ device_id: 'kiosk-123456789', label: null, entries: [], module_users: 3 }),
        dev({ device_id: 'k2', module_users: undefined }),
      ],
    })
    const wrapper = await mountManager()
    const devices = wrapper.findAll('[data-testid="vein-fleet-device"]')
    expect(devices[0]!.text()).toContain('kiosk-12')
    expect(devices[0]!.text()).toContain('まだ誰も入っていません')
    expect(devices[0]!.find('[data-testid="vein-fleet-mismatch"]').exists()).toBe(true)
    expect(devices[1]!.text()).toContain('モジュール -')
    expect(devices[1]!.find('[data-testid="vein-fleet-mismatch"]').exists()).toBe(false)
  })

  it('★ 記録を登録した端末を出し、報告した端末自身で登録した記録には印を付ける', async () => {
    listVeinFleet.mockResolvedValue({
      devices: [dev({
        device_id: 'alarm-0123456789abcdef',
        entries: [
          { module_id: 10, employee_id: 'e1', approved: true, registered_device_id: 'alarm:0123456789abcdef' },
          { module_id: 11, employee_id: 'e2', approved: true, registered_device_id: 'kiosk-123456789' },
        ],
      })],
    })
    const wrapper = await mountManager()
    expect(wrapper.findAll('[data-testid="vein-fleet-registered"]').map(c => c.text())).toEqual([
      'Vein Station 01234567 (この端末)',
      'kiosk-12',
    ])
  })

  it('鍵で端末になった機 (alarm-<指紋>) はラベルが無ければ Vein Station と指紋の頭で出す', async () => {
    listVeinFleet.mockResolvedValue({ devices: [dev({ device_id: 'alarm-0123456789abcdef', label: null })] })
    const wrapper = await mountManager()
    expect(wrapper.find('[data-testid="vein-fleet-device"] h3').text()).toBe('Vein Station 01234567')
  })

  it('端末ごとに最終の記録の版 (いちばん新しい版) を出す。版が無い端末は -、読めない版はそのまま', async () => {
    listVeinFleet.mockResolvedValue({
      devices: [
        dev({ entries: [
          { module_id: 10, employee_id: 'e1', approved: true, version: '2026-10-21T00:00:00Z' },
          { module_id: 11, employee_id: 'e2', approved: true, version: '2026-10-23T01:02:03Z' },
          { module_id: 12, employee_id: 'e3', approved: true },
        ] }),
        dev({ device_id: 'k2' }),
        dev({ device_id: 'k3', entries: [{ module_id: 10, employee_id: 'e1', approved: true, version: 'v-x' }] }),
      ],
    })
    const wrapper = await mountManager()
    const latest = wrapper.findAll('[data-testid="vein-fleet-latest"]').map(e => e.text())
    expect(latest).toEqual([
      `最終の記録の版 ${new Date('2026-10-23T01:02:03Z').toLocaleString('ja-JP')}`,
      '最終の記録の版 -',
      '最終の記録の版 v-x',
    ])
  })

  it('★ 「更新した」の合図で引き直す', async () => {
    const wrapper = await mountManager()
    listVeinFleet.mockResolvedValue({ devices: [] })
    watchOptions().onVeinListUpdated()
    await flushPromises()
    expect(listVeinFleet).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="vein-fleet-empty"]').exists()).toBe(true)
  })

  it('「最新を取る」で合図を出し直す。繋がっている端末が無ければそう出す', async () => {
    const wrapper = await mountManager()
    requestVeinFleet.mockResolvedValue({ sent: 0 })
    await wrapper.find('[data-testid="vein-fleet-request"]').trigger('click')
    await flushPromises()
    expect(requestVeinFleet).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="vein-fleet-notice"]').text()).toContain('いま繋がっている端末がありません')
  })

  it('失敗を出す (名前が引けなくても一覧は出す)', async () => {
    getEmployees.mockRejectedValue(new Error('x'))
    listVeinFleet.mockRejectedValue(new Error('API エラー (403): 指静脈の一覧は管理者のみ見られます'))
    requestVeinFleet.mockRejectedValue(new Error('ログインが必要です'))
    const wrapper = await mountManager()
    expect(wrapper.find('[data-testid="vein-fleet-error"]').text()).toContain('403')
    expect(wrapper.find('[data-testid="vein-fleet-notice"]').text()).toBe('ログインが必要です')

    listVeinFleet.mockRejectedValue('x')
    requestVeinFleet.mockRejectedValue('x')
    await wrapper.find('[data-testid="vein-fleet-request"]').trigger('click')
    watchOptions().onVeinListUpdated()
    await flushPromises()
    expect(wrapper.find('[data-testid="vein-fleet-error"]').text()).toBe('一覧を取得できませんでした')
    expect(wrapper.find('[data-testid="vein-fleet-notice"]').text()).toBe('問い合わせに失敗しました')
  })
})
