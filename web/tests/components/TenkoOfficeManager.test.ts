// 管理者の画面のタブ「点呼の営業所」。値は架空。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoOfficeManager from '~/components/TenkoOfficeManager.vue'

const api = vi.hoisted(() => ({
  getTenkoOffices: vi.fn(),
  getEmployees: vi.fn(),
  createTenkoOffice: vi.fn(),
  updateTenkoOffice: vi.fn(),
  deleteTenkoOffice: vi.fn(),
  listCamHostKeys: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const OFFICES = {
  offices: [
    { id: 'o1', name: '本社営業所', company_name: null, address: null, manager_ids: ['m1'], vehicle_ids: ['v1'], carins_bases: [{ use_base: '長崎県長崎市', user_name: '一歩運輸' }], device_ids: ['alarm:aa11bb22cc33dd44'] },
    { id: 'o2', name: '帯広営業所', company_name: 'グループ運輸', address: '帯広市', manager_ids: [], vehicle_ids: [], carins_bases: [], device_ids: [] },
  ],
  carins_bases: [
    { use_base: '長崎県長崎市', user_name: '一歩運輸', office_id: 'o1', vehicle_count: 3 },
    { use_base: '佐賀県佐賀市', user_name: '一歩運輸', office_id: null, vehicle_count: 1 },
  ],
  vehicles: [
    { id: 'v1', registration_number: '品川100あ1234', display_name: '1 号車', office_id: 'o1' },
    { id: 'v2', registration_number: '帯広100か5678', display_name: null, office_id: null },
  ],
}
const EMPLOYEES = [
  { id: 'm1', name: '運行 一郎', role: ['manager'] },
  { id: 'm2', name: '管理 次郎', role: ['admin'] },
  { id: 'd1', name: '乗務 三郎', role: ['driver'] },
]

async function mountIt() {
  const w = await mountSuspended(TenkoOfficeManager)
  await flushPromises()
  return w
}
type W = Awaited<ReturnType<typeof mountIt>>
const cards = (w: W) => w.findAll('[data-testid="tenko-office"]')
const btn = (w: W, i: number, id: string) => cards(w)[i]!.find(`[data-testid="${id}"]`)

beforeEach(() => {
  vi.clearAllMocks()
  api.getTenkoOffices.mockResolvedValue(OFFICES)
  api.getEmployees.mockResolvedValue(EMPLOYEES)
  api.listCamHostKeys.mockResolvedValue({ keys: [
    { device_id: 'alarm:aa11bb22cc33dd44', label: '長崎の点呼端末' },
    { device_id: 'alarm:5de95ff4aabbccdd', label: null },
  ] })
})

describe('TenkoOfficeManager', () => {
  it('営業所と所属を出す。運行管理者の選択肢は manager / admin だけ、別の営業所の車両はその名前を添える', async () => {
    const w = await mountIt()
    expect(api.getEmployees).toHaveBeenCalledWith('admin')
    expect(cards(w)).toHaveLength(2)
    expect((btn(w, 0, 'tenko-office-name').element as HTMLInputElement).value).toBe('本社営業所')
    expect((btn(w, 1, 'tenko-office-company').element as HTMLInputElement).value).toBe('グループ運輸')
    const managers = cards(w)[0]!.findAll('[data-testid="tenko-office-manager"]')
    expect(managers).toHaveLength(2)
    expect((managers[0]!.element as HTMLInputElement).checked).toBe(true)
    expect(cards(w)[0]!.text()).toContain('品川100あ1234 (1 号車)')
    expect(cards(w)[0]!.find('[data-testid="tenko-office-vehicle-elsewhere"]').exists()).toBe(false)
    expect(cards(w)[1]!.find('[data-testid="tenko-office-vehicle-elsewhere"]').text()).toContain('いまは 本社営業所')
    expect(w.find('[data-testid="tenko-offices-cohabit-hint"]').text()).toContain('同じ建物でも会社が違えば、会社ごとに別の営業所として登録します')
  })

  it('車検証の使用の本拠・使用者の組を選ぶ。台数と、別の営業所の組はその名前を出し、選ぶと移して送る', async () => {
    api.updateTenkoOffice.mockResolvedValue(OFFICES.offices[1])
    const w = await mountIt()
    const bases = cards(w)[0]!.findAll('[data-testid="tenko-office-carins-base"]')
    expect((bases[0]!.element as HTMLInputElement).checked).toBe(true)
    expect(cards(w)[0]!.text()).toContain('長崎県長崎市 / 一歩運輸')
    expect(cards(w)[0]!.text()).toContain('(3 台)')
    expect(cards(w)[1]!.find('[data-testid="tenko-office-carins-base-elsewhere"]').text()).toContain('いまは 本社営業所')
    await cards(w)[1]!.findAll('[data-testid="tenko-office-carins-base"]')[0]!.setValue(true)
    await btn(w, 1, 'tenko-office-save').trigger('click')
    await flushPromises()
    expect(api.updateTenkoOffice.mock.calls[0][1].carins_bases).toEqual([{ use_base: '長崎県長崎市', user_name: '一歩運輸' }])
  })

  it('点呼端末 (機体の鍵) を選ぶ。名前の無い機体は指紋の頭で出し、ほかの営業所にも所属する端末はその名前を出す (選んでも移らない)', async () => {
    api.updateTenkoOffice.mockResolvedValue(OFFICES.offices[1])
    const w = await mountIt()
    const devs = cards(w)[1]!.findAll('[data-testid="tenko-office-device"]')
    expect(devs).toHaveLength(2)
    expect(cards(w)[1]!.text()).toContain('長崎の点呼端末 aa11bb22')
    expect(cards(w)[1]!.text()).toContain('名前の無い機体 5de95ff4')
    expect(cards(w)[1]!.find('[data-testid="tenko-office-device-elsewhere"]').text()).toContain('ほかに 本社営業所')
    expect(cards(w)[0]!.find('[data-testid="tenko-office-device-elsewhere"]').exists()).toBe(false)
    await devs[0]!.setValue(true)
    await btn(w, 1, 'tenko-office-save').trigger('click')
    await flushPromises()
    expect(api.updateTenkoOffice.mock.calls[0][1].device_ids).toEqual(['alarm:aa11bb22cc33dd44'])
  })

  it('このブラウザで最後にキオスクの鍵を取った機体は「(この端末)」と出し、一覧の先頭に置く', async () => {
    localStorage.setItem('alc_device_id_kiosk', 'alarm:5de95ff4aabbccdd')
    const w = await mountIt()
    const devs = cards(w)[0]!.findAll('[data-testid="tenko-office-device"]')
    expect(devs[0]!.element.parentElement!.textContent).toContain('名前の無い機体 5de95ff4')
    expect(cards(w)[0]!.findAll('[data-testid="tenko-office-this-device"]')).toHaveLength(1)
    expect(devs[0]!.element.parentElement!.textContent).toContain('(この端末)')
    localStorage.removeItem('alc_device_id_kiosk')
  })

  it('既存の営業所を保存すると全部を置き換えて読み直す (空の会社名・所在地は null)', async () => {
    api.updateTenkoOffice.mockResolvedValue(OFFICES.offices[0])
    const w = await mountIt()
    await cards(w)[0]!.findAll('[data-testid="tenko-office-vehicle"]')[1]!.setValue(true)
    await btn(w, 0, 'tenko-office-save').trigger('click')
    await flushPromises()
    expect(api.updateTenkoOffice).toHaveBeenCalledWith('o1', {
      name: '本社営業所', company_name: null, address: null, manager_ids: ['m1'], vehicle_ids: ['v1', 'v2'],
      carins_bases: [{ use_base: '長崎県長崎市', user_name: '一歩運輸' }], device_ids: ['alarm:aa11bb22cc33dd44'],
    })
    expect(api.getTenkoOffices).toHaveBeenCalledTimes(2)
    expect(w.find('[data-testid="tenko-offices-notice"]').text()).toBe('本社営業所 を保存しました')
  })

  it('追加した営業所は作成で送り、未保存のまま削除すると消えるだけ', async () => {
    api.createTenkoOffice.mockResolvedValue({ ...OFFICES.offices[0], id: 'o3' })
    const w = await mountIt()
    await w.find('[data-testid="tenko-offices-add"]').trigger('click')
    expect(cards(w)).toHaveLength(3)
    await btn(w, 2, 'tenko-office-delete').trigger('click')
    expect(cards(w)).toHaveLength(2)
    expect(api.deleteTenkoOffice).not.toHaveBeenCalled()
    await w.find('[data-testid="tenko-offices-add"]').trigger('click')
    await btn(w, 2, 'tenko-office-name').setValue('釧路営業所')
    await btn(w, 2, 'tenko-office-company').setValue('グループ運輸')
    await btn(w, 2, 'tenko-office-address').setValue('釧路市')
    await cards(w)[2]!.findAll('[data-testid="tenko-office-manager"]')[1]!.setValue(true)
    await btn(w, 2, 'tenko-office-save').trigger('click')
    await flushPromises()
    expect(api.createTenkoOffice).toHaveBeenCalledWith({
      name: '釧路営業所', company_name: 'グループ運輸', address: '釧路市', manager_ids: ['m2'], vehicle_ids: [], carins_bases: [], device_ids: [],
    })
  })

  it('保存済みの営業所を削除する', async () => {
    api.deleteTenkoOffice.mockResolvedValue(undefined)
    const w = await mountIt()
    await btn(w, 1, 'tenko-office-delete').trigger('click')
    await flushPromises()
    expect(api.deleteTenkoOffice).toHaveBeenCalledWith('o2')
    expect(w.find('[data-testid="tenko-offices-notice"]').text()).toBe('帯広営業所 を削除しました')
  })

  it('保存・削除の失敗は語を日本語にして行に出す。知らない文言はそのまま、文言が無ければ既定の文', async () => {
    api.updateTenkoOffice.mockRejectedValueOnce(new Error('API error 400: {"error":"invalid_name"}'))
    const w = await mountIt()
    await btn(w, 0, 'tenko-office-save').trigger('click')
    await flushPromises()
    expect(btn(w, 0, 'tenko-office-error').text()).toBe('営業所の名称を入力してください')
    api.deleteTenkoOffice.mockRejectedValueOnce(new Error('boom'))
    await btn(w, 1, 'tenko-office-delete').trigger('click')
    await flushPromises()
    expect(btn(w, 1, 'tenko-office-error').text()).toBe('boom')
    api.deleteTenkoOffice.mockRejectedValueOnce(new Error(''))
    await btn(w, 1, 'tenko-office-delete').trigger('click')
    await flushPromises()
    expect(btn(w, 1, 'tenko-office-error').text()).toBe('削除できませんでした')
  })

  it('読めなければその旨を出し、運行管理者も車両も無ければ空の案内を出す', async () => {
    api.getTenkoOffices.mockRejectedValueOnce(new Error('API error 403: {"error":"forbidden"}'))
    const w = await mountIt()
    expect(w.find('[data-testid="tenko-offices-load-error"]').text()).toBe('システム管理者だけが変更できます')
    api.getTenkoOffices.mockResolvedValue({ offices: [], vehicles: [], carins_bases: [] })
    api.getEmployees.mockResolvedValue([])
    api.listCamHostKeys.mockRejectedValue(new Error('ログインが必要です'))
    const empty = await mountIt()
    await empty.find('[data-testid="tenko-offices-add"]').trigger('click')
    expect(cards(empty)[0]!.text()).toContain('運行管理者がまだいません')
    expect(cards(empty)[0]!.text()).toContain('車両マスタに車両がありません')
    expect(cards(empty)[0]!.text()).toContain('車検証が取り込まれていません')
    expect(cards(empty)[0]!.text()).toContain('点呼端末がありません')
  })
})
