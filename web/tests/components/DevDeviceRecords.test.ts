// dev端末 (開発用の鍵) の記録を見る画面 (Refs ippoan/alc-app#387)。
//
// 出すのは index.vue のハンバーガーで、キオスクの鍵に dev の印がある端末だけ。
// ここでは中身の 3 点 — 説明の 1 行 / 既存の一覧 (TenkoSessionMonitor) / 印を外す — を見る。
// TenkoSessionMonitor の中身は自前のテスト (TenkoSessionMonitor.test.ts) が見るので stub。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DevDeviceRecords from '~/components/DevDeviceRecords.vue'
import TenkoSessionMonitor from '~/components/TenkoSessionMonitor.vue'
import { isDevDevice, noteDeviceToken } from '~/utils/token-selection'
import { devDeviceJwt } from '../helpers/dummy-jwt'

const KEY = 'alc_dev_device_kiosk'

function mountRecords() {
  return mountSuspended(DevDeviceRecords, { global: { stubs: { TenkoSessionMonitor: true } } })
}

beforeEach(() => {
  noteDeviceToken('kiosk', devDeviceJwt())
})

afterEach(() => {
  vi.unstubAllGlobals()
  noteDeviceToken('kiosk', null)
  localStorage.clear()
})

describe('DevDeviceRecords', () => {
  it('開発用の鍵であることと、記録が本番に出ないことを 1 行で出す', async () => {
    const wrapper = await mountRecords()
    expect(wrapper.text()).toContain('この端末は開発用の鍵です。ここで行った点呼・測定・打刻は本番の記録に出ません')
    wrapper.unmount()
  })

  it('一覧は既存の TenkoSessionMonitor をそのまま置く (新しい一覧を作らない)', async () => {
    const wrapper = await mountRecords()
    expect(wrapper.findAllComponents(TenkoSessionMonitor)).toHaveLength(1)
    wrapper.unmount()
  })

  it('★ 印を外す: 確認を 1 回挟み、OK なら memory と localStorage の印を消して cleared を上げる', async () => {
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const wrapper = await mountRecords()
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
    const wrapper = await mountRecords()

    await wrapper.find('[data-testid="dev-records-clear"]').trigger('click')

    expect(isDevDevice('kiosk')).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('1')
    expect(wrapper.emitted('cleared')).toBeUndefined()
    wrapper.unmount()
  })

  it('鍵が挿さったままならまた印が立つことをボタンの近くに書いてある', async () => {
    const wrapper = await mountRecords()
    expect(wrapper.text()).toContain('開発用の鍵が挿さったままなら、次にトークンを取った時点でまた印が立ちます')
    wrapper.unmount()
  })
})
