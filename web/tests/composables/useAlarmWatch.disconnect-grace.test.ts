// 繋がっていた警告デバイスが切れてからの猶予 (Refs ippoan/alc-app#387)。
// 期限を切るのは useManagerDeviceToken の側 (useManagerDeviceToken.test.ts が見る)。ここは
// 「いつ期限を入れ・外すか」と、表示用の残り秒だけ。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { withSetup } from '../helpers/with-setup'

// 見張りは component から切り離してあり、止めるのは設定 off だけ。前のテストの見張りが
// 次のテストの接続に反応しないよう、接続の ref はテストごとに作り直す
let isConnected = ref(false)
mockNuxtImport('useAlarmDevice', () => () => ({
  isSupported: true,
  isConnected: readonly(isConnected),
  connect: () => {},
  disconnect: async () => {},
}))

mockNuxtImport('useActiveRooms', () => () => ({ start: () => {}, stop: () => {} }))

const enabled = ref<boolean | null>(true)
mockNuxtImport('useAlarmDeviceSetting', () => () => ({
  enabled: readonly(enabled),
  setEnabled: vi.fn(),
}))

// 呼び順を 1 本の配列に記録する (繋がり直したときは「期限を外す → 取りに行く」の順)
const calls: string[] = []
mockNuxtImport('useManagerDeviceToken', () => () => ({
  prefetchManagerJwt: async () => { calls.push('prefetch') },
  setDisconnectDeadline: (deadlineMs: number) => { calls.push(`set(${deadlineMs})`) },
  clearDisconnectDeadline: () => { calls.push('clear') },
}))

type Mod = typeof import('~/composables/useAlarmWatch')
let useAlarmWatch: Mod['useAlarmWatch']
let remainingSeconds: ReturnType<Mod['useSeatDisconnectGrace']>['remainingSeconds']
let GRACE_MS: number

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)

/** 繋がった状態の席を用意する (呼び出しの記録は空にして返す) */
async function mountConnected() {
  const [, app] = withSetup(() => useAlarmWatch())
  isConnected.value = true
  await nextTick()
  calls.length = 0
  return app
}

describe('useAlarmWatch — 切断の猶予', () => {
  beforeEach(async () => {
    // Date も止める (残り秒は期限と今の差分)。nextTick は promise なので止まらない
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(T0)
    isConnected = ref(false)
    enabled.value = true
    calls.length = 0
    vi.resetModules()
    const mod = await import('~/composables/useAlarmWatch')
    useAlarmWatch = mod.useAlarmWatch
    remainingSeconds = mod.useSeatDisconnectGrace().remainingSeconds
    GRACE_MS = mod.SEAT_DISCONNECT_GRACE_MS
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('猶予は 2 分', () => {
    expect(GRACE_MS).toBe(120_000)
  })

  it('繋がっていたものが切れたら 2 分後を期限として入れ、残り秒が 120 から 1 秒ずつ減る', async () => {
    const app = await mountConnected()
    expect(remainingSeconds.value).toBeNull()

    isConnected.value = false
    await nextTick()
    expect(calls).toEqual([`set(${T0 + 120_000})`])
    expect(remainingSeconds.value).toBe(120)

    vi.advanceTimersByTime(1000)
    expect(remainingSeconds.value).toBe(119)
    vi.advanceTimersByTime(59_000)
    expect(remainingSeconds.value).toBe(60)
    // 期限を入れるのは切れたときの 1 回だけ (1 秒ごとの処理はトークンに触らない)
    expect(calls).toEqual([`set(${T0 + 120_000})`])
    app.unmount()
  })

  it('起動直後の「まだ繋がっていない」では始めない (期限も入れず、タイマーも張らない)', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    await nextTick()
    expect(calls).toEqual([])
    expect(remainingSeconds.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    app.unmount()
  })

  it('猶予のあいだに繋がり直したら数えるのをやめ、期限を外してから取りに行く', async () => {
    const app = await mountConnected()
    isConnected.value = false
    await nextTick()
    vi.advanceTimersByTime(30_000)
    expect(remainingSeconds.value).toBe(90)
    calls.length = 0

    isConnected.value = true
    await nextTick()
    expect(calls).toEqual(['clear', 'prefetch'])
    expect(remainingSeconds.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    // もう一度切れたら、そこから 2 分を数え直す
    calls.length = 0
    isConnected.value = false
    await nextTick()
    expect(calls).toEqual([`set(${T0 + 30_000 + 120_000})`])
    expect(remainingSeconds.value).toBe(120)
    app.unmount()
  })

  it('2 分たったら数えるのをやめて null に戻す (タイマーを残さない)。その後に繋がり直せば期限を外す', async () => {
    const app = await mountConnected()
    isConnected.value = false
    await nextTick()

    vi.advanceTimersByTime(119_000)
    expect(remainingSeconds.value).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(remainingSeconds.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    // 期限が来ても、ここからトークンには何もしない (期限はトークンの側が持っている)
    expect(calls).toEqual([`set(${T0 + 120_000})`])

    calls.length = 0
    isConnected.value = true
    await nextTick()
    expect(calls).toEqual(['clear', 'prefetch'])
    expect(remainingSeconds.value).toBeNull()
    app.unmount()
  })

  it('残り秒は時刻の差分 — 1 秒ごとの処理が遅れて飛んでも、回数ではなく時刻に合う', async () => {
    const app = await mountConnected()
    isConnected.value = false
    await nextTick()
    expect(remainingSeconds.value).toBe(120)

    // タイマーを 1 度も走らせずに 45.3 秒進め、そこから 1 回だけ走らせる
    vi.setSystemTime(T0 + 45_300)
    vi.advanceTimersToNextTimer()
    expect(remainingSeconds.value).toBe(Math.ceil((T0 + 120_000 - Date.now()) / 1000))
    expect(remainingSeconds.value).toBeLessThan(75)

    // 期限を過ぎてから走った 1 回でも、負の秒を出さずに終わる
    vi.setSystemTime(T0 + 500_000)
    vi.advanceTimersToNextTimer()
    expect(remainingSeconds.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    app.unmount()
  })

  it('数えている最中に設定を off にしたら、猶予なしでその場で期限を切り、数えるのをやめる', async () => {
    const app = await mountConnected()
    isConnected.value = false
    await nextTick()
    vi.advanceTimersByTime(10_000)
    expect(remainingSeconds.value).toBe(110)
    calls.length = 0

    enabled.value = false
    await nextTick()
    expect(calls).toEqual([`set(${T0 + 10_000})`])
    expect(remainingSeconds.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    app.unmount()
  })

  it('繋がったまま設定を off にしたら、猶予なしでその場で期限を切る (数え始めない)', async () => {
    const app = await mountConnected()
    vi.setSystemTime(T0 + 5000)

    enabled.value = false
    await nextTick()
    expect(calls).toEqual([`set(${T0 + 5000})`])

    // 見張りは止めてあるので、この後の切断では猶予を始めない
    isConnected.value = false
    await nextTick()
    expect(calls).toEqual([`set(${T0 + 5000})`])
    expect(remainingSeconds.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    app.unmount()
  })

  it('設定を on に戻した時点で繋がっていれば期限を外す。繋がっていなければ切ったまま', async () => {
    const app = await mountConnected()
    enabled.value = false
    await nextTick()
    isConnected.value = false
    await nextTick()
    calls.length = 0

    // 繋がっていない: 始め直しても期限には触らない (起動直後と同じ)
    enabled.value = true
    await nextTick()
    expect(calls).toEqual([])
    expect(remainingSeconds.value).toBeNull()

    isConnected.value = true
    await nextTick()
    expect(calls).toEqual(['clear', 'prefetch'])
    app.unmount()
  })

  it('トップ画面が unmount されても猶予は進む (止めるのは設定 off だけ)', async () => {
    const app = await mountConnected()
    app.unmount()

    isConnected.value = false
    await nextTick()
    expect(calls).toEqual([`set(${T0 + 120_000})`])
    vi.advanceTimersByTime(2000)
    expect(remainingSeconds.value).toBe(118)
  })
})
