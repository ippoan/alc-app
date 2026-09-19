// 「この画面を測定台として扱うか」の判定 1 か所 (Refs ippoan/alc-app#368)。
//
// 長い URL (`/?role=driver&tab=bp&station=bp`) を人に配る運用をやめるため、
// **端末の名乗り** (`DEVICE bp-station` → `useSerialArbiter.arbitratedDeviceKind`) を
// 一次情報にし、URL の印は判断材料の 1 つとして残す (既存 URL と PWA を壊さないため)。
//
// ここで固定するのは 3 つ:
//   1. URL 無しでも、名乗りで決着すれば測定台
//   2. **未確定 (null) では測定台にしない** — probe 前にキオスクを巻き込まない
//   3. CoreS3 優先で other に倒された PC も測定台にしない
import { describe, it, expect, beforeEach } from 'vitest'
import { ref, readonly } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useBpStationMode } from '~/composables/useBpStationMode'

const query = ref<Record<string, string>>({})
mockNuxtImport('useRoute', () => () => ({ query: query.value }))

const arbitratedDeviceKind = ref<'bp-station' | 'other' | null>(null)
mockNuxtImport('useSerialArbiter', () => () => ({
  arbitratedDeviceKind: readonly(arbitratedDeviceKind),
}))

describe('useBpStationMode — 測定台かどうかは URL と端末の名乗りの OR (Refs ippoan/alc-app#368)', () => {
  beforeEach(() => {
    query.value = {}
    arbitratedDeviceKind.value = null
  })

  it('★ 未確定のあいだは測定台にしない (probe 前にキオスクを巻き込まない)', () => {
    const { isBpStation, isBpStationUrl } = useBpStationMode()
    expect(isBpStation.value).toBe(false)
    expect(isBpStationUrl).toBe(false)
  })

  it('★ URL に印が無くても、端末が bp-station と名乗れば測定台', () => {
    arbitratedDeviceKind.value = 'bp-station'
    const { isBpStation } = useBpStationMode()
    expect(isBpStation.value).toBe(true)
  })

  it('名乗りが後から決着しても入れ替わる (computed なので画面は読み直さなくてよい)', () => {
    const { isBpStation } = useBpStationMode()
    expect(isBpStation.value).toBe(false)

    arbitratedDeviceKind.value = 'bp-station'
    expect(isBpStation.value).toBe(true)
  })

  it('★ CoreS3 優先で other に倒された PC は測定台にしない', () => {
    arbitratedDeviceKind.value = 'other'
    const { isBpStation } = useBpStationMode()
    expect(isBpStation.value).toBe(false)
  })

  it('?station=bp 付きなら、名乗りを待たずに測定台 (既存 URL / インストール済み PWA)', () => {
    query.value = { station: 'bp' }
    const { isBpStation, isBpStationUrl } = useBpStationMode()
    expect(isBpStation.value).toBe(true)
    expect(isBpStationUrl).toBe(true)
  })

  it('?station=bp 付きなら、名乗りが other でも測定台のまま (URL を壊さない)', () => {
    query.value = { station: 'bp' }
    arbitratedDeviceKind.value = 'other'
    const { isBpStation } = useBpStationMode()
    expect(isBpStation.value).toBe(true)
  })

  it('★ isBpStationUrl は URL のぶんだけ — 名乗りでは true にならない (URL に印を焼き付けないため)', () => {
    arbitratedDeviceKind.value = 'bp-station'
    const { isBpStation, isBpStationUrl } = useBpStationMode()
    expect(isBpStation.value).toBe(true)
    expect(isBpStationUrl).toBe(false)
  })

  it('?tab=bp では測定台にしない (ハンバーガーの URL 同期がどの端末でも書く印なので)', () => {
    query.value = { tab: 'bp' }
    const { isBpStation } = useBpStationMode()
    expect(isBpStation.value).toBe(false)
  })
})
