// dev端末 (開発用の鍵) の記録を見る画面 (Refs ippoan/alc-app#387)。
//
// 出すのは index.vue のハンバーガーで、キオスクの鍵に dev の印がある端末だけ。
// ここでは中身の 3 点 — 説明の 1 行 / 記録の取得 (既存の口だけを叩く) / 印を外す — を見る。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DevDeviceRecords from '~/components/DevDeviceRecords.vue'
import { isDevDevice, noteDeviceToken } from '~/utils/token-selection'
import { devDeviceJwt } from '../helpers/dummy-jwt'

const downloadMock = vi.fn(async (..._args: unknown[]) => {})
vi.mock('~/utils/api', () => ({
  downloadTenkoRecordsCsv: (...args: unknown[]) => downloadMock(...args),
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const KEY = 'alc_dev_device_kiosk'

beforeEach(() => {
  downloadMock.mockReset()
  downloadMock.mockResolvedValue(undefined)
  noteDeviceToken('kiosk', devDeviceJwt())
})

afterEach(() => {
  vi.unstubAllGlobals()
  noteDeviceToken('kiosk', null)
  localStorage.clear()
})

describe('DevDeviceRecords', () => {
  it('開発用の鍵であることと、記録が本番に出ないことを 1 行で出す', async () => {
    const wrapper = await mountSuspended(DevDeviceRecords)
    expect(wrapper.text()).toContain('この端末は開発用の鍵です。ここで行った点呼・測定・打刻は本番の記録に出ません')
    wrapper.unmount()
  })

  it('点呼記録の CSV は既存の口 (downloadTenkoRecordsCsv) で取る', async () => {
    const wrapper = await mountSuspended(DevDeviceRecords)
    await wrapper.find('[data-testid="dev-records-csv"]').trigger('click')
    await flush()
    expect(downloadMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="dev-records-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('取得中はボタンを止め、終われば戻す', async () => {
    let finish: (() => void) | undefined
    downloadMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const wrapper = await mountSuspended(DevDeviceRecords)
    const button = wrapper.find('[data-testid="dev-records-csv"]')

    await button.trigger('click')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toBe('ダウンロード中…')

    finish!()
    await flush()
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.text()).toBe('点呼記録を CSV で出す')
    wrapper.unmount()
  })

  it('取得に失敗したら理由を出す (Error 以外が投げられても落ちない)', async () => {
    const wrapper = await mountSuspended(DevDeviceRecords)

    downloadMock.mockRejectedValueOnce(new Error('CSV ダウンロード失敗 (403): forbidden'))
    await wrapper.find('[data-testid="dev-records-csv"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="dev-records-error"]').text()).toBe('CSV ダウンロード失敗 (403): forbidden')

    downloadMock.mockRejectedValueOnce('boom')
    await wrapper.find('[data-testid="dev-records-csv"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="dev-records-error"]').text()).toBe('CSV ダウンロードエラー')

    // 次に成功すれば消える
    await wrapper.find('[data-testid="dev-records-csv"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="dev-records-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('★ 印を外す: 確認を 1 回挟み、OK なら memory と localStorage の印を消して cleared を上げる', async () => {
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const wrapper = await mountSuspended(DevDeviceRecords)
    expect(localStorage.getItem(KEY)).toBe('1')

    await wrapper.find('[data-testid="dev-records-clear"]').trigger('click')

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(isDevDevice('kiosk')).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(wrapper.emitted('cleared')).toHaveLength(1)
    wrapper.unmount()
  })

  it('確認でキャンセルしたら何も変えない', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const wrapper = await mountSuspended(DevDeviceRecords)

    await wrapper.find('[data-testid="dev-records-clear"]').trigger('click')

    expect(isDevDevice('kiosk')).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('1')
    expect(wrapper.emitted('cleared')).toBeUndefined()
    wrapper.unmount()
  })

  it('鍵が挿さったままならまた印が立つことをボタンの近くに書いてある', async () => {
    const wrapper = await mountSuspended(DevDeviceRecords)
    expect(wrapper.text()).toContain('開発用の鍵が挿さったままなら、次にトークンを取った時点でまた印が立ちます')
    wrapper.unmount()
  })
})
