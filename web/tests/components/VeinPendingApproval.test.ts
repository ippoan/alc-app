// 未承認の指静脈を、運行管理者が端末で承認する (Refs ippoan/alc-app#436)。乗務員は合成値
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import VeinPendingApproval from '~/components/VeinPendingApproval.vue'
import { resetDeviceNames } from '~/composables/useDeviceNames'

const api = vi.hoisted(() => ({
  listCamHostKeys: vi.fn(),
  listDeviceLabels: vi.fn(),
  getPendingVeinModuleTemplates: vi.fn(),
  approveVeinByEmployee: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))
const db = vi.hoisted(() => ({ loadVeinModuleEntries: vi.fn() }))
vi.mock('~/utils/vein-db', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-db')>()),
  ...db,
}))
const sync = vi.hoisted(() => ({ syncVeinModule: vi.fn() }))
vi.mock('~/utils/vein-module', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-module')>()),
  ...sync,
}))

const vein = vi.hoisted(() => ({
  isConnected: null as unknown as { value: boolean },
  say: vi.fn(),
  identify: vi.fn(),
}))
mockNuxtImport('useVeinSerial', () => () => vein)

const PENDING = [
  { employee_id: 'emp-new', name: '試験 新人', updated_at: '2026-10-23T00:00:00Z', registered_device_id: 'alarm:0123456789abcdef' },
  { employee_id: 'emp-2', name: '試験 二郎', updated_at: 'v-x', registered_device_id: null },
]
const ENTRIES = [
  { employeeId: 'emp-mgr', moduleId: 10, updatedAt: 'v1', approved: true },
  { employeeId: 'emp-new', moduleId: 11, updatedAt: 'v1', approved: false },
]

async function mountPanel() {
  const w = await mountSuspended(VeinPendingApproval)
  await flushPromises()
  return w
}
const find = (w: Awaited<ReturnType<typeof mountPanel>>, id: string) => w.find(`[data-testid="${id}"]`)

async function selectFirstAndApprove(w: Awaited<ReturnType<typeof mountPanel>>) {
  await w.findAll('[data-testid="vein-pending-row"]')[0]!.trigger('click')
  await find(w, 'vein-pending-approve').trigger('click')
  await flushPromises()
}

describe('VeinPendingApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDeviceNames()
    // 名前の表は既定で取れない (今の短い表記)
    api.listCamHostKeys.mockRejectedValue(new Error('403'))
    api.listDeviceLabels.mockRejectedValue(new Error('403'))
    vein.isConnected = ref(true)
    vein.say.mockResolvedValue(undefined)
    vein.identify.mockResolvedValue(10)
    api.getPendingVeinModuleTemplates.mockResolvedValue(PENDING)
    api.approveVeinByEmployee.mockResolvedValue(undefined)
    db.loadVeinModuleEntries.mockResolvedValue(ENTRIES)
    sync.syncVeinModule.mockResolvedValue(true)
  })

  it('★ 登録した端末は機体の鍵のラベルで出す。引けなければ今の短い表記', async () => {
    api.listCamHostKeys.mockResolvedValue({ keys: [], names: [{ device_id: 'alarm:0123456789abcdef', label: '帯広の Vein Station', revoked: false }] })
    const w = await mountPanel()
    const rows = w.findAll('[data-testid="vein-pending-row"]').map(r => r.text())
    expect(rows[0]).toContain('帯広の Vein Station')
    expect(rows[0]).not.toContain('Vein Station 01234567')
    expect(rows[1]).toContain('不明')
  })

  it('未承認の一覧を出す (登録した時刻と端末)。無ければそう出す。取れなければ理由', async () => {
    const w = await mountPanel()
    const rows = w.findAll('[data-testid="vein-pending-row"]').map(r => r.text())
    expect(rows[0]).toContain('試験 新人')
    expect(rows[0]).toContain('Vein Station 01234567')
    expect(rows[1]).toContain('v-x')
    expect(rows[1]).toContain('不明')
    api.getPendingVeinModuleTemplates.mockResolvedValue([])
    expect(find(await mountPanel(), 'vein-pending-empty').exists()).toBe(true)
    api.getPendingVeinModuleTemplates.mockRejectedValue(new Error('403'))
    expect(find(await mountPanel(), 'vein-pending-list-error').text()).toContain('403')
    api.getPendingVeinModuleTemplates.mockRejectedValue('x')
    expect(find(await mountPanel(), 'vein-pending-list-error').text()).toContain('(x)')
  })

  it('★ 選んで運行管理者が指を置くと、照合で決まった承認者で承認を頼み、一覧を読み直して同期する', async () => {
    const w = await mountPanel()
    await selectFirstAndApprove(w)
    expect(vein.say).toHaveBeenCalledWith('PLACE')
    expect(api.approveVeinByEmployee).toHaveBeenCalledWith('emp-new', 'emp-mgr', '2026-10-23T00:00:00Z')
    expect(find(w, 'vein-pending-message').text()).toBe('試験 新人さんの指静脈を承認しました')
    expect(sync.syncVeinModule).toHaveBeenCalledTimes(1)
    expect(api.getPendingVeinModuleTemplates).toHaveBeenCalledTimes(2)
    expect(find(w, 'vein-pending-approve').exists()).toBe(false)
  })

  it('照合が不一致・対応表に無い ID・承認待ちの ID なら承認を頼まない', async () => {
    const w = await mountPanel()
    vein.identify.mockResolvedValueOnce(null)
    await selectFirstAndApprove(w)
    expect(find(w, 'vein-pending-error').text()).toContain('一致しませんでした')
    vein.identify.mockResolvedValueOnce(99)
    await find(w, 'vein-pending-approve').trigger('click')
    await flushPromises()
    expect(find(w, 'vein-pending-error').text()).toContain('一致しませんでした')
    vein.identify.mockResolvedValueOnce(11)
    await find(w, 'vein-pending-approve').trigger('click')
    await flushPromises()
    expect(find(w, 'vein-pending-error').text()).toContain('未承認です')
    expect(api.approveVeinByEmployee).not.toHaveBeenCalled()
    expect(vein.say).toHaveBeenCalledWith('FAILED')
  })

  it.each([
    ['approver_not_manager', '運行管理者ではありません'],
    ['approver_not_enrolled', '運行管理者の指静脈が承認されていません'],
    ['self_approval', '自分の登録は自分で承認できません'],
  ])('サーバーが断った理由 (%s) を出す', async (code, text) => {
    api.approveVeinByEmployee.mockRejectedValue(new Error(`API エラー (403): {"error":"${code}"}`))
    const w = await mountPanel()
    await selectFirstAndApprove(w)
    expect(find(w, 'vein-pending-error').text()).toContain(text)
  })

  it('409 は登録し直されたと出す。ほかの失敗は理由を添える。撮り直しの合図でボタンの文言を変える', async () => {
    api.approveVeinByEmployee.mockRejectedValueOnce(new Error('API エラー (409): conflict'))
    const w = await mountPanel()
    await selectFirstAndApprove(w)
    expect(find(w, 'vein-pending-error').text()).toContain('登録し直されました')
    vein.identify.mockRejectedValueOnce('boom')
    await find(w, 'vein-pending-approve').trigger('click')
    await flushPromises()
    expect(find(w, 'vein-pending-error').text()).toBe('承認できませんでした (boom)')

    let finish: (id: number | null) => void = () => {}
    vein.identify.mockImplementationOnce((onAgain?: () => void) => new Promise((resolve) => { finish = resolve; onAgain?.() }))
    await find(w, 'vein-pending-approve').trigger('click')
    await flushPromises()
    expect(find(w, 'vein-pending-approve').text()).toBe('もう一度置いてください…')
    finish(null)
    await flushPromises()
  })

  it('読み直すで取り直し、閉じるで close', async () => {
    const w = await mountPanel()
    await w.findAll('button').find(b => b.text() === '読み直す')!.trigger('click')
    await flushPromises()
    expect(api.getPendingVeinModuleTemplates).toHaveBeenCalledTimes(2)
    await w.findAll('button').find(b => b.text() === '閉じる')!.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
