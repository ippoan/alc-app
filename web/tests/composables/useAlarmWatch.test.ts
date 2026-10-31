import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'

// --- composable のモック (呼び順を 1 本の配列に記録して「対で動く」ことを検証する) ---

const calls: string[] = []

const alarmState = { isSupported: true }
// VoiceS3R が繋がっているか (Vein Base が警告デバイスを兼ねるかの切り替えを見る)。
// 前のテストの見張りが残るので、テストごとに作り直す
let alarmConnected = ref(false)
const heartbeatLine = () => 'HB OK'
mockNuxtImport('useAlarmDevice', () => () => ({
  isSupported: alarmState.isSupported,
  isConnected: readonly(alarmConnected),
  connect: (delay: number) => { calls.push(`connect(${delay})`) },
  disconnect: async () => { calls.push('disconnect') },
  heartbeatLine,
}))

// Vein Base へ送る警告の heartbeat の始め・止め (呼び順は calls と分けて記録する)
const veinAlarmCalls: string[] = []
const veinAlarmStart = vi.fn((line: () => string) => { veinAlarmCalls.push(`start(${line()})`) })

// Vein Base (席の鍵にする席のため、見張りの開始で登録する)。ポートは指静脈・キオスクの鍵と
// 共有なので、見張りをやめても手放さない (disconnect を持たせず、呼ばれたら落ちる)
mockNuxtImport('useVeinSerial', () => () => ({
  isConnected: ref(false),
  connect: async () => { calls.push('vein.connect'); return false },
  alarm: {
    start: veinAlarmStart,
    stop: (off: boolean) => { veinAlarmCalls.push(`stop(${off})`) },
  },
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
    veinAlarmCalls.length = 0
    alarmConnected = ref(false)
    alarmState.isSupported = true
    enabled.value = true
    vi.resetModules()
    useAlarmWatch = (await import('~/composables/useAlarmWatch')).useAlarmWatch
  })

  it('設定 on なら mount で着信購読 → 接続の順に対で始め、unmount では止めない', () => {
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect'])

    // トップ画面を離れても singleton は動いたまま (ロールタブ切替で鳴らさない #205)
    app.unmount()
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect'])
  })

  it('設定を off にしたときだけ切断 → 購読停止を対で行い、on に戻せば対で始め直す', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect'])

    enabled.value = false
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect', 'disconnect', 'stop'])

    enabled.value = true
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect', 'disconnect', 'stop', 'start', 'connect(0)', 'vein.connect'])
    app.unmount()
  })

  it('再 mount (2 つ目の呼び出し) では二重に始めず、off では 1 回だけ止める', async () => {
    const [, first] = withSetup(() => useAlarmWatch())
    first.unmount()
    const [, second] = withSetup(() => useAlarmWatch())
    const [, third] = withSetup(() => useAlarmWatch())
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect'])

    // 生きている 2 instance の watch が両方動いても、止めるのは 1 回
    enabled.value = false
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect', 'disconnect', 'stop'])
    second.unmount()
    third.unmount()
  })

  it('VoiceS3R が無いあいだは Vein Base に警告の heartbeat を送り、VoiceS3R が繋がったら HB OFF で解く', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    // 始めた時点で VoiceS3R が無い: Vein Base が警告デバイスを兼ねる (行は VoiceS3R と同じ関数で作る)
    expect(veinAlarmCalls).toEqual(['start(HB OK)'])
    expect(veinAlarmStart).toHaveBeenLastCalledWith(heartbeatLine)

    // VoiceS3R が繋がった: Vein Base の見張りを HB OFF で解く (送らずにやめると鳴る)
    alarmConnected.value = true
    await nextTick()
    expect(veinAlarmCalls).toEqual(['start(HB OK)', 'stop(true)'])

    // VoiceS3R が抜けた: また Vein Base へ送る
    alarmConnected.value = false
    await nextTick()
    expect(veinAlarmCalls).toEqual(['start(HB OK)', 'stop(true)', 'start(HB OK)'])
    app.unmount()
  })

  it('設定を off にしたら Vein Base の見張りを HB OFF で解き、その後の接続の変化も見ない', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    enabled.value = false
    await nextTick()
    // Vein は挿したままなので、HB OFF を送らないと off にした端末で鳴り続ける
    expect(veinAlarmCalls).toEqual(['start(HB OK)', 'stop(true)'])

    alarmConnected.value = true
    await nextTick()
    expect(veinAlarmCalls).toEqual(['start(HB OK)', 'stop(true)'])
    app.unmount()
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
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect'])

    // 未設定へ戻っても (localStorage を消した等) 止めない — 止めるのは off だけ
    enabled.value = null
    await nextTick()
    expect(calls).toEqual(['start', 'connect(0)', 'vein.connect'])
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
