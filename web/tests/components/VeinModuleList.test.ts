import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import VeinModuleList from '~/components/VeinModuleList.vue'
import type { VeinModuleEntry } from '~/utils/vein-db'
import { resetDeviceNames } from '~/composables/useDeviceNames'

// この端末の指静脈の一覧 (Refs ippoan/alc-app#436)。乗務員はすべて合成値

const { getEmployeesMock, loadEntriesMock, listCamHostKeysMock, listDeviceLabelsMock } = vi.hoisted(() => ({
  listCamHostKeysMock: vi.fn(),
  listDeviceLabelsMock: vi.fn(),
  getEmployeesMock: vi.fn(),
  loadEntriesMock: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getEmployees: getEmployeesMock,
  listCamHostKeys: listCamHostKeysMock,
  listDeviceLabels: listDeviceLabelsMock,
}))
vi.mock('~/utils/vein-db', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/vein-db')>()),
  loadVeinModuleEntries: loadEntriesMock,
}))
const vein = vi.hoisted(() => ({ syncInfo: vi.fn() }))
mockNuxtImport('useVeinSerial', () => () => vein)
const deviceToken = vi.hoisted(() => ({ getDeviceJwt: vi.fn() }))
mockNuxtImport('useDeviceToken', () => () => deviceToken)

/** 署名はダミー (画面は sub を読むだけ) */
function jwtWithSub(sub: unknown): string {
  const seg = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${seg({ alg: 'none' })}.${seg({ sub })}.sig`
}

function entry(employeeId: string, moduleId: number, approved = true): VeinModuleEntry {
  return { employeeId, moduleId, updatedAt: '2026-10-22T00:00:00Z', approved }
}

async function mountList() {
  const w = await mountSuspended(VeinModuleList)
  await flushPromises()
  return w
}

describe('VeinModuleList', () => {
  beforeEach(() => {
    resetDeviceNames()
    // 名前の表は既定で取れない (今の短い表記)
    listCamHostKeysMock.mockReset().mockRejectedValue(new Error('403'))
    listDeviceLabelsMock.mockReset().mockRejectedValue(new Error('403'))
    loadEntriesMock.mockReset().mockResolvedValue([entry('emp-b', 12, false), entry('emp-a', 10)])
    getEmployeesMock.mockReset().mockResolvedValue([{ id: 'emp-a', name: '試験 一郎' }, { id: 'emp-b', name: '試験 二郎' }])
    vein.syncInfo.mockReset().mockResolvedValue({ users: 2, max: 100 })
    deviceToken.getDeviceJwt.mockReset().mockResolvedValue(null)
  })

  it('★ 登録した端末を出し、この端末で登録した記録には印を付ける。分からなければ不明', async () => {
    deviceToken.getDeviceJwt.mockResolvedValue(jwtWithSub('alarm:0123456789abcdef'))
    loadEntriesMock.mockResolvedValue([
      { ...entry('emp-a', 10), registeredDeviceId: 'alarm:0123456789abcdef' },
      { ...entry('emp-b', 11), registeredDeviceId: 'kiosk-123456789' },
      entry('emp-c', 12),
    ])
    const w = await mountList()
    expect(w.findAll('[data-testid="vein-module-registered"]').map(c => c.text())).toEqual([
      'Vein Station 01234567 (この端末)',
      'kiosk-12',
      '不明',
    ])
  })

  it('★ 鍵のラベルが引けた端末はそのラベルで出す。引けない端末は今の短い表記', async () => {
    deviceToken.getDeviceJwt.mockResolvedValue(jwtWithSub('alarm:0123456789abcdef'))
    listCamHostKeysMock.mockResolvedValue({ keys: [], names: [{ device_id: 'alarm:0123456789abcdef', label: '帯広の Vein Station', revoked: false }] })
    loadEntriesMock.mockResolvedValue([
      { ...entry('emp-a', 10), registeredDeviceId: 'alarm:0123456789abcdef' },
      { ...entry('emp-b', 11), registeredDeviceId: 'kiosk-123456789' },
    ])
    const w = await mountList()
    expect(w.findAll('[data-testid="vein-module-registered"]').map(c => c.text())).toEqual([
      '帯広の Vein Station (この端末)',
      'kiosk-12',
    ])
  })

  it('この端末の token が取れない・sub が文字列でないなら印を付けない', async () => {
    loadEntriesMock.mockResolvedValue([{ ...entry('emp-a', 10), registeredDeviceId: 'kiosk-1' }])
    deviceToken.getDeviceJwt.mockRejectedValue(new Error('no key'))
    const a = await mountList()
    expect(a.find('[data-testid="vein-module-registered"]').text()).toBe('kiosk-1')
    deviceToken.getDeviceJwt.mockResolvedValue(jwtWithSub(1))
    const b = await mountList()
    expect(b.find('[data-testid="vein-module-registered"]').text()).toBe('kiosk-1')
  })

  it('ID の順に乗務員・状態を並べ、対応表の人数・空き・モジュールの登録人数を出す', async () => {
    const w = await mountList()
    const rows = w.findAll('[data-testid="vein-module-table"] tbody tr').map(r => r.text())
    expect(rows[0]).toContain('10')
    expect(rows[0]).toContain('試験 一郎')
    expect(rows[0]).toContain('承認済み')
    expect(rows[1]).toContain('12')
    expect(rows[1]).toContain('承認待ち')
    const summary = w.find('[data-testid="vein-module-summary"]').text()
    expect(summary).toContain('2 人 (空き 89 / 91)')
    expect(summary).toContain('2 人 (上限 100)')
    expect(getEmployeesMock).toHaveBeenCalledWith('bp-station')
    expect(w.find('[data-testid="vein-module-mismatch"]').exists()).toBe(false)
  })

  it('最終の記録の版 (いちばん新しい版) を要約に出す。誰も居なければ -', async () => {
    loadEntriesMock.mockResolvedValue([
      { ...entry('emp-a', 10), updatedAt: '2026-10-21T00:00:00Z' },
      { ...entry('emp-b', 15), updatedAt: '2026-10-23T01:02:03Z' },
      { ...entry('emp-c', 11), updatedAt: '2026-10-22T00:00:00Z' },
    ])
    const w = await mountList()
    const latest = w.find('[data-testid="vein-module-latest"]').text()
    expect(latest).toBe(`${new Date('2026-10-23T01:02:03Z').toLocaleString('ja-JP')} (ID 15)`)
    loadEntriesMock.mockResolvedValue([])
    const empty = await mountList()
    expect(empty.find('[data-testid="vein-module-latest"]').text()).toBe('-')
  })

  it('モジュールと対応表の人数が違えば知らせる。名前が引けなければ ID で出す', async () => {
    vein.syncInfo.mockResolvedValue({ users: 0, max: 100 })
    getEmployeesMock.mockRejectedValue(new Error('offline'))
    const w = await mountList()
    expect(w.find('[data-testid="vein-module-mismatch"]').exists()).toBe(true)
    expect(w.text()).toContain('(名前不明 emp-a)')
  })

  it('モジュールの人数を読めなければ理由を出す。空きが無ければ知らせる。誰も居なければそう出す', async () => {
    vein.syncInfo.mockRejectedValue(new Error('TIMEOUT'))
    loadEntriesMock.mockResolvedValue(Array.from({ length: 91 }, (_, i) => entry(`x${i}`, 10 + i)))
    const w = await mountList()
    expect(w.text()).toContain('モジュールの登録人数を読めませんでした (TIMEOUT)')
    expect(w.text()).toContain('ID の空きがありません')
    loadEntriesMock.mockResolvedValue([])
    vein.syncInfo.mockResolvedValue({ users: 0, max: 100 })
    const empty = await mountList()
    expect(empty.text()).toContain('まだ誰も入っていません')
  })

  it('読み直すで取り直し、閉じるで close', async () => {
    const w = await mountList()
    const buttons = w.findAll('button')
    await buttons.find(b => b.text() === '読み直す')!.trigger('click')
    await flushPromises()
    expect(loadEntriesMock).toHaveBeenCalledTimes(2)
    await buttons.find(b => b.text() === '閉じる')!.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
