import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'

// --- composable のモック (呼び順を 1 本の配列に記録して「対で動く」ことを検証する) ---

const calls: string[] = []

const alarmState = { isSupported: true }
mockNuxtImport('useAlarmDevice', () => () => ({
  isSupported: alarmState.isSupported,
  connect: (delay: number) => { calls.push(`connect(${delay})`) },
  disconnect: async () => { calls.push('disconnect') },
}))

mockNuxtImport('useActiveRooms', () => () => ({
  start: () => { calls.push('start') },
  stop: () => { calls.push('stop') },
}))

// この端末で警告デバイスを使うか (true / false / null = 未設定)
const enabled = ref<boolean | null>(true)
mockNuxtImport('useAlarmDeviceSetting', () => () => ({
  enabled: readonly(enabled),
  setEnabled: vi.fn(),
}))

// 「始めたか」は module スコープ (アプリ全体で 1 つ) なので、テストごとに読み直す
let useAlarmWatch: typeof import('~/composables/useAlarmWatch').useAlarmWatch

describe('useAlarmWatch', () => {
  beforeEach(async () => {
    calls.length = 0
    alarmState.isSupported = true
    enabled.value = true
    vi.resetModules()
    useAlarmWatch = (await import('~/composables/useAlarmWatch')).useAlarmWatch
  })

  it('設定 on なら mount で着信購読 → 接続の順に対で始め、unmount では止めない', () => {
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual(['start', 'connect(0)'])

    // トップ画面を離れても singleton は動いたまま (ロールタブ切替で鳴らさない #205)
    app.unmount()
    expect(calls).toEqual(['start', 'connect(0)'])
  })

  it('設定を off にしたときだけ切断 → 購読停止を対で行い、on に戻せば対で始め直す', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual(['start', 'connect(0)'])

    enabled.value = false
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'disconnect', 'stop'])

    enabled.value = true
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'disconnect', 'stop', 'start', 'connect(0)'])
    app.unmount()
  })

  it('再 mount (2 つ目の呼び出し) では二重に始めず、off では 1 回だけ止める', async () => {
    const [, first] = withSetup(() => useAlarmWatch())
    first.unmount()
    const [, second] = withSetup(() => useAlarmWatch())
    const [, third] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual(['start', 'connect(0)'])

    // 生きている 2 instance の watch が両方動いても、止めるのは 1 回
    enabled.value = false
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'disconnect', 'stop'])
    second.unmount()
    third.unmount()
  })

  it('設定 off の端末では何も始めない', () => {
    enabled.value = false
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual([])
    app.unmount()
  })

  it('未設定のあいだは始めず、[つなぐ] で true になった瞬間に始める。[つながない] では何もしない', async () => {
    enabled.value = null
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual([])

    // 始めていないので、off にしても切るものが無い
    enabled.value = false
    await nextTick()
    expect(calls).toEqual([])

    enabled.value = true
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)'])

    // 未設定へ戻っても (localStorage を消した等) 止めない — 止めるのは off だけ
    enabled.value = null
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)'])
    app.unmount()
  })

  it('Web Serial が無いブラウザでは購読も接続も立てず、設定の変化も見ない', async () => {
    alarmState.isSupported = false
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual([])

    enabled.value = false
    await nextTick()
    enabled.value = true
    await nextTick()
    expect(calls).toEqual([])
    app.unmount()
  })
})
