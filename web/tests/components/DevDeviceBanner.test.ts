// 「開発用の端末です」の帯 (Refs ippoan/alc-app#387)。
//
// 端末の鍵に dev の印がある端末にだけ、画面の一番上に出す。**印が 1 つも無い端末
// (= 本番の全端末) では DOM に 1 つも出さない**。印は reactive ではないので、
// 印が変わったときのイベント (DEV_DEVICE_MARK_EVENT) で読み直す。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DevDeviceBanner from '~/components/DevDeviceBanner.vue'
import {
  clearDevDeviceMark, noteDeviceToken, DEV_DEVICE_MARK_EVENT, type DeviceTokenKind,
} from '~/utils/token-selection'
import { devDeviceJwt, plainDeviceJwt } from '../helpers/dummy-jwt'

const BANNER = '[data-testid="dev-device-banner"]'
const KINDS: DeviceTokenKind[] = ['kiosk', 'manager-device', 'bp-station']

afterEach(() => {
  vi.restoreAllMocks()
  for (const kind of KINDS) noteDeviceToken(kind, null)
  localStorage.clear()
})

describe('DevDeviceBanner', () => {
  it('★ 印が 1 つも無い端末では何も描画しない (帯の要素ごと無い)', async () => {
    const wrapper = await mountSuspended(DevDeviceBanner)
    expect(wrapper.find(BANNER).exists()).toBe(false)
    expect(wrapper.html()).not.toContain('開発用')
    wrapper.unmount()
  })

  it('dev でない端末のトークンが取れている端末でも出ない', async () => {
    noteDeviceToken('kiosk', plainDeviceJwt())
    const wrapper = await mountSuspended(DevDeviceBanner)
    expect(wrapper.find(BANNER).exists()).toBe(false)
    wrapper.unmount()
  })

  it('キオスクの印がある端末では帯が出て、開発用であることと種類を書く', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    const wrapper = await mountSuspended(DevDeviceBanner)

    const banner = wrapper.find(BANNER)
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('開発用の端末です')
    expect(banner.text()).toContain('この端末の記録は本番の記録簿に出ません (キオスク)')
    // 表示だけ — 押せるものを持たない
    expect(banner.findAll('button')).toHaveLength(0)
    wrapper.unmount()
  })

  it.each([
    { kind: 'manager-device' as const, label: '運行管理者席' },
    { kind: 'bp-station' as const, label: '血圧測定台' },
  ])('$kind の印 → 「$label」と出す', async ({ kind, label }) => {
    noteDeviceToken(kind, devDeviceJwt())
    const wrapper = await mountSuspended(DevDeviceBanner)
    expect(wrapper.find(BANNER).text()).toContain(`(${label})`)
    wrapper.unmount()
  })

  it('2 種類の印 → 両方の表示名を「・」でつなぐ', async () => {
    noteDeviceToken('bp-station', devDeviceJwt())
    noteDeviceToken('kiosk', devDeviceJwt())
    const wrapper = await mountSuspended(DevDeviceBanner)
    expect(wrapper.find(BANNER).text()).toContain('(キオスク・血圧測定台)')
    wrapper.unmount()
  })

  it('★ mount 後に印が立つと (イベントで) 帯が現れ、外すと消える', async () => {
    const wrapper = await mountSuspended(DevDeviceBanner)
    expect(wrapper.find(BANNER).exists()).toBe(false)

    noteDeviceToken('manager-device', devDeviceJwt())
    await nextTick()
    expect(wrapper.find(BANNER).exists()).toBe(true)
    expect(wrapper.find(BANNER).text()).toContain('運行管理者席')

    clearDevDeviceMark('manager-device')
    await nextTick()
    expect(wrapper.find(BANNER).exists()).toBe(false)
    wrapper.unmount()
  })

  it('dev でないトークンに替わっても消える', async () => {
    noteDeviceToken('kiosk', devDeviceJwt())
    const wrapper = await mountSuspended(DevDeviceBanner)
    expect(wrapper.find(BANNER).exists()).toBe(true)

    noteDeviceToken('kiosk', plainDeviceJwt())
    await nextTick()
    expect(wrapper.find(BANNER).exists()).toBe(false)
    wrapper.unmount()
  })

  it('unmount で listener を外し、そのあとのイベントで例外にならない', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const wrapper = await mountSuspended(DevDeviceBanner)

    wrapper.unmount()

    expect(removeSpy.mock.calls.some(([name]) => name === DEV_DEVICE_MARK_EVENT)).toBe(true)
    expect(() => noteDeviceToken('kiosk', devDeviceJwt())).not.toThrow()
    expect(() => clearDevDeviceMark('kiosk')).not.toThrow()
  })
})
