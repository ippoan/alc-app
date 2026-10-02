// 警告デバイスが繋がるたびに、運行管理者の鍵のトークンを先に取っておく (Refs ippoan/alc-app#387)。
// 見張りの開始・停止そのものは useAlarmWatch.test.ts が見る。ここは先取りだけ。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, readonly, nextTick } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
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

// 先取りの中身 (抑止の期限を戻す・例外を出さない) は useManagerDeviceToken.test.ts が見る
// 返すのは取れたかどうか。既定は取れた (= 試し直さない)
const prefetchManagerJwt = vi.fn(async () => true)
// 切断の猶予 (期限を入れる・外す) は useAlarmWatch.disconnect-grace.test.ts が見る
mockNuxtImport('useManagerDeviceToken', () => () => ({
  prefetchManagerJwt,
  setDisconnectDeadline: vi.fn(),
  clearDisconnectDeadline: vi.fn(),
}))

let useAlarmWatch: typeof import('~/composables/useAlarmWatch').useAlarmWatch

async function settle() {
  await nextTick()
  await flushPromises()
}

describe('useAlarmWatch — 運行管理者の鍵のトークンの先取り', () => {
  beforeEach(async () => {
    isConnected = ref(false)
    enabled.value = true
    prefetchManagerJwt.mockReset()
    prefetchManagerJwt.mockImplementation(async () => true)
    vi.resetModules()
    useAlarmWatch = (await import('~/composables/useAlarmWatch')).useAlarmWatch
  })

  it('警告デバイスが繋がったら 1 回取りに行く。繋がっていないあいだは取りに行かない', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    await settle()
    expect(prefetchManagerJwt).not.toHaveBeenCalled()

    isConnected.value = true
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('始めた時点で既に繋がっていれば、そのとき 1 回取りに行く', async () => {
    isConnected.value = true
    const [, app] = withSetup(() => useAlarmWatch())
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('切れて繋がり直したら、もう 1 回取りに行く (切れたときは取りに行かない)', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    isConnected.value = false
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)

    isConnected.value = true
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('設定を off にして止めた後は、繋がっても取りに行かない。on に戻せばまた見張る', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    enabled.value = false
    await settle()

    isConnected.value = true
    await settle()
    expect(prefetchManagerJwt).not.toHaveBeenCalled()

    // 始め直した時点で繋がっているので、そのとき 1 回
    enabled.value = true
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('2 つ目の呼び出しがあっても見張りは 1 つ (繋がって取りに行くのは 1 回)', async () => {
    const [, first] = withSetup(() => useAlarmWatch())
    const [, second] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })

  it('トップ画面が unmount されても見張りは続く (止めるのは設定 off だけ)', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    app.unmount()

    isConnected.value = true
    await settle()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
  })

  it('Web Serial の設定が未設定の席では見張らない', async () => {
    enabled.value = null
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    expect(prefetchManagerJwt).not.toHaveBeenCalled()
    app.unmount()
  })
})

// 接続時の先取りが失敗したら、その接続につき 1 回だけ試し直す (Refs ippoan/alc-app#387)。
// 席にはほかに取り直す引き金が無く、失敗したままだと画面の「確認できませんでした」が残る
describe('useAlarmWatch — 先取りの試し直し', () => {
  let RETRY_MS: number

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    isConnected = ref(false)
    enabled.value = true
    prefetchManagerJwt.mockReset()
    prefetchManagerJwt.mockImplementation(async () => true)
    vi.resetModules()
    const mod = await import('~/composables/useAlarmWatch')
    useAlarmWatch = mod.useAlarmWatch
    RETRY_MS = mod.PREFETCH_RETRY_DELAY_MS
  })

  afterEach(() => {
    // 見張りを止めてから時計を戻す (次のテストへ見張りと待ちを持ち越さない)
    enabled.value = false
    vi.useRealTimers()
  })

  /** 時計を止めたままでも進むもの (nextTick と promise) だけを流す */
  async function settleFake() {
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('署名の待ち (10 秒) とは別の長さで待つ', () => {
    expect(RETRY_MS).toBe(15_000)
  })

  it('★ 先取りが失敗したら、定数の時間の後に 1 回だけ呼び直す (その前には呼ばない)', async () => {
    prefetchManagerJwt.mockImplementationOnce(async () => false)
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settleFake()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RETRY_MS - 1)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(2)

    // 試し直しは 1 回だけ (定周期にはしない)
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('先取りが取れた接続では呼び直さない', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settleFake()
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('★ 2 回目も失敗したら、3 回目は無い', async () => {
    prefetchManagerJwt.mockImplementation(async () => false)
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settleFake()
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('待っている間に切れたら呼び直さない。繋がり直せば、また 1 回ぶん試せる', async () => {
    prefetchManagerJwt.mockImplementation(async () => false)
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settleFake()
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1)

    isConnected.value = false
    await settleFake()
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)

    // 繋がり直した: 接続時の 1 回 + 試し直しの 1 回
    isConnected.value = true
    await settleFake()
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(3)
    app.unmount()
  })

  it('先取りが返る前に切れたら、失敗で返っても試し直しを始めない', async () => {
    let resolveFirst!: (obtained: boolean) => void
    prefetchManagerJwt.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve }))
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settleFake()

    isConnected.value = false
    await settleFake()
    resolveFirst(false)
    await settleFake()
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('設定を off にして見張りをやめたら、待っていた試し直しを取り消す', async () => {
    prefetchManagerJwt.mockImplementation(async () => false)
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settleFake()

    enabled.value = false
    await settleFake()
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(prefetchManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})
