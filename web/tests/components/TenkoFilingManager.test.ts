// 管理者の画面のタブ「点呼の届出」。値は架空。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoFilingManager from '~/components/TenkoFilingManager.vue'
import { emptySettings, type FilingSettings } from '~/utils/tenko-forms'

const api = vi.hoisted(() => ({
  getTenkoFilingSettings: vi.fn(),
  putTenkoFilingSettings: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))
const forms = vi.hoisted(() => ({
  buildFilledForm: vi.fn(),
  saveBytes: vi.fn(),
}))
vi.mock('~/utils/tenko-forms', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/tenko-forms')>()),
  ...forms,
}))

function saved(over: Partial<FilingSettings> = {}): FilingSettings {
  return { ...emptySettings(), business_number: '000000000001', updated_at: '2026-11-02T00:00:00Z', ...over }
}

async function mountIt(s: FilingSettings | Error = saved()) {
  if (s instanceof Error) api.getTenkoFilingSettings.mockRejectedValue(s)
  else api.getTenkoFilingSettings.mockResolvedValue(s)
  const w = await mountSuspended(TenkoFilingManager)
  await flushPromises()
  return w
}
type W = Awaited<ReturnType<typeof mountIt>>
const dlButtons = (w: W) => w.findAll('[data-testid^="tenko-filing-dl-"]').map(b => b.attributes('data-testid'))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TenkoFilingManager', () => {
  it('保存した値を出し、種別ごとに様式を並べる', async () => {
    const w = await mountIt()
    expect((w.find('[data-testid="tenko-filing-business-number"]').element as HTMLInputElement).value).toBe('000000000001')
    expect(dlButtons(w)).toEqual(['tenko-filing-dl-egov-tenko-todokede-sankou', 'tenko-filing-dl-remote-kamotsu-bessi7-jisshi'])
    await w.find('[data-testid="tenko-filing-kind-auto"]').setValue(true)
    expect(dlButtons(w)).toEqual([
      'tenko-filing-dl-egov-tenko-todokede-sankou',
      'tenko-filing-dl-nintei-yoshiki1-shinsei',
      'tenko-filing-dl-nintei-yoshiki2-gaiyo',
    ])
    expect(w.text()).toContain('認定番号が要ります')
  })

  it('読めないときは文言を出す (理由の記号は文にする)', async () => {
    const w = await mountIt(new Error('403 {"error":"forbidden"}'))
    expect(w.find('[data-testid="tenko-filing-load-error"]').text()).toBe('システム管理者だけが変更できます')
    const other = await mountIt(new Error(''))
    expect(other.find('[data-testid="tenko-filing-load-error"]').text()).toBe('設定を取得できませんでした')
  })

  it('営業所を足して消し、保存する', async () => {
    const w = await mountIt(saved({ offices: [] }))
    await w.find('[data-testid="tenko-filing-add-office"]').trigger('click')
    await w.find('[data-testid="tenko-filing-add-office"]').trigger('click')
    const rows = () => w.findAll('[data-testid="tenko-filing-settings"] select').slice(1)
    expect(rows().map(s => (s.element as HTMLSelectElement).value)).toEqual(['1', '2'])
    await w.findAll('button').find(b => b.text() === '削除')!.trigger('click')
    api.putTenkoFilingSettings.mockResolvedValue(saved({ offices: [{ name: '', address: '', role: 2 }] }))
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(api.putTenkoFilingSettings.mock.calls[0]![0].offices).toEqual([{ name: '', address: '', role: 2 }])
    expect(w.find('[data-testid="tenko-filing-notice"]').text()).toBe('保存しました')
  })

  it('保存が外れたら理由を出す', async () => {
    const w = await mountIt()
    api.putTenkoFilingSettings.mockRejectedValueOnce(new Error('400 {"error":"invalid_business_number"}'))
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-save-error"]').text()).toBe('事業者番号は半角数字 12 桁で入力してください')
    api.putTenkoFilingSettings.mockRejectedValueOnce('x')
    await w.find('[data-testid="tenko-filing-save"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-save-error"]').text()).toBe('保存できませんでした')
  })

  it('記入済みをダウンロードする (入力中の値と日付で)', async () => {
    const offices = Array.from({ length: 6 }, (_, i) => ({ name: `架空 ${i}`, address: null, role: 2 }))
    const w = await mountIt(saved({ offices }))
    expect(w.text()).toContain('5 件までです')
    forms.buildFilledForm.mockResolvedValue({ bytes: new Uint8Array([1]), filename: 'a.xlsx' })
    await w.find('[data-testid="tenko-filing-start-date"]').setValue('2026-11-20')
    await w.find('[data-testid="tenko-filing-dl-egov-tenko-todokede-sankou"]').trigger('click')
    await flushPromises()
    const [form, s, req] = forms.buildFilledForm.mock.calls[0]!
    expect([form.id, s.business_number, req.kind, req.startDate]).toEqual(['egov-tenko-todokede-sankou', '000000000001', 'remote', '2026-11-20'])
    expect(req.applyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(forms.saveBytes).toHaveBeenCalledWith(new Uint8Array([1]), 'a.xlsx', 'xlsx')

    forms.buildFilledForm.mockRejectedValueOnce(new Error('様式の版が想定と違います'))
    await w.find('[data-testid="tenko-filing-dl-remote-kamotsu-bessi7-jisshi"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-download-error"]').text()).toBe('様式の版が想定と違います')
    forms.buildFilledForm.mockRejectedValueOnce(null)
    await w.find('[data-testid="tenko-filing-dl-remote-kamotsu-bessi7-jisshi"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="tenko-filing-download-error"]').text()).toBe('様式を作れませんでした')
  })
})
