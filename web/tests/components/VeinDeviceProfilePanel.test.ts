import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import VeinDeviceProfilePanel from '~/components/VeinDeviceProfilePanel.vue'

// 指静脈の個体値の計測の画面。乗務員はすべて合成値

const { getEmployeesMock, loadEntriesMock, judgedMock } = vi.hoisted(() => ({
  getEmployeesMock: vi.fn(),
  loadEntriesMock: vi.fn(),
  judgedMock: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployees: getEmployeesMock,
  postVeinAuthShotJudged: judgedMock,
}))
vi.mock('~/utils/vein-db', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-db')>()),
  loadVeinModuleEntries: loadEntriesMock,
}))
const vein = vi.hoisted(() => ({
  isSupported: true,
  isConnected: { value: true },
  connect: vi.fn(),
  identifyKeep: vi.fn(),
}))
mockNuxtImport('useVeinSerial', () => () => ({ ...vein, isConnected: ref(vein.isConnected.value) }))

async function mountPanel(props: Record<string, unknown> = {}) {
  const w = await mountSuspended(VeinDeviceProfilePanel, { props })
  await flushPromises()
  return w
}

describe('VeinDeviceProfilePanel', () => {
  beforeEach(() => {
    vein.isConnected.value = true
    vein.identifyKeep.mockReset().mockResolvedValue({ id: 10, record: new Uint8Array([1]), score: 70, thresholds: null, firmware: null })
    loadEntriesMock.mockReset().mockResolvedValue([
      { employeeId: 'emp-b', moduleId: 12, updatedAt: 't', approved: false },
      { employeeId: 'emp-a', moduleId: 10, updatedAt: 't', approved: true },
    ])
    getEmployeesMock.mockReset().mockResolvedValue([{ id: 'emp-a', name: '試験 一郎' }, { id: 'emp-b', name: '試験 二郎' }, { id: 'emp-c', name: '試験 三郎' }])
    judgedMock.mockReset().mockResolvedValue({ result: 'match', scores: [60, 61, 80], rule: 'A', shift: { entry: 1, dx: -3, dy: 1, overlap: 700, overlap0: 600 } })
  })

  it('モジュールにいる人 (承認待ちは印付き) と、いない人を分けて選べ、選ぶまで始められない。名前は渡した鍵で引く', async () => {
    const w = await mountPanel({ scope: 'manager-device' })
    const select = w.find('[data-testid="vein-profile-employee"]')
    expect(select.findAll('optgroup').map(g => g.attributes('label'))).toEqual(['この端末のモジュールにいる人', 'モジュールにいない人'])
    const options = select.findAll('option').map(o => o.text())
    expect(options).toEqual(['選んでください', '10: 試験 一郎', '12: 試験 二郎 (承認待ち)', '試験 三郎'])
    expect(w.find('[data-testid="vein-profile-empty"]').exists()).toBe(false)
    expect(getEmployeesMock).toHaveBeenCalledWith('manager-device')
    expect(w.find('[data-testid="vein-profile-start"]').attributes('disabled')).toBeDefined()
  })

  it('★ 計測すると 1 回ずつの表と、この端末の個体値を出す', async () => {
    const w = await mountPanel({ scope: 'bp-station' })
    await w.find('[data-testid="vein-profile-employee"]').setValue('emp-a')
    await w.find('[data-testid="vein-profile-count"]').setValue('1')
    await w.find('[data-testid="vein-profile-start"]').trigger('click')
    await flushPromises()
    expect(vein.identifyKeep).toHaveBeenCalledTimes(1)
    expect(judgedMock.mock.calls[0]![1]).toBe('bp-station')
    const rows = w.find('[data-testid="vein-profile-table"]').findAll('tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('本人')
    expect(rows[0]!.text()).toContain('60/61/80')
    const summary = w.find('[data-testid="vein-profile-summary"]').text()
    expect(summary).toContain('この端末の個体値 (1 回)')
    expect(summary).toContain('dx: -3.0 ± 0.0 (1)')
  })

  it('Vein Station がつながっていなければ理由を出して始められない。閉じるで close', async () => {
    vein.isConnected.value = false
    const w = await mountPanel({ closeLabel: '通常点呼に戻る' })
    expect(w.find('[data-testid="vein-profile-disabled"]').text()).toContain('接続されていません')
    await w.find('[data-testid="vein-profile-employee"]').setValue('emp-a')
    expect(w.find('[data-testid="vein-profile-start"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="vein-profile-close"]').trigger('click')
    expect(w.find('[data-testid="vein-profile-close"]').text()).toBe('通常点呼に戻る')
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('VeinDeviceProfilePanel — モジュールが空の端末', () => {
  it('モジュールに誰もいなくても、乗務員の一覧から選んで計れる', async () => {
    vein.isConnected.value = true
    loadEntriesMock.mockReset().mockResolvedValue([])
    getEmployeesMock.mockReset().mockResolvedValue([{ id: 'emp-a', name: '試験 一郎' }])
    const w = await mountPanel()
    expect(w.find('[data-testid="vein-profile-empty"]').text()).toContain('モジュールにいない人も選べます')
    expect(w.find('[data-testid="vein-profile-employee"]').findAll('option').map(o => o.text())).toEqual(['選んでください', '試験 一郎'])
    await w.find('[data-testid="vein-profile-employee"]').setValue('emp-a')
    expect(w.find('[data-testid="vein-profile-start"]').attributes('disabled')).toBeUndefined()
  })
})
