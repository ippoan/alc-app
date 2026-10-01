// 警告デバイスが繋がるたびに、運行管理者の鍵のトークンを先に取っておく (Refs ippoan/alc-app#387)。
// 見張りの開始・停止そのものは useAlarmWatch.test.ts が見る。ここは先取りだけ。
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// 本物と同じ形 (戻り値の backoffUntil は readonly) にして、戻す書き込みが元の ref に届くことまで見る
const backoffUntil = ref(0)
const getManagerJwt = vi.fn<() => Promise<string | null>>()
const useManagerDeviceTokenMock = vi.fn(() => ({
  getManagerJwt,
  backoffUntil: readonly(backoffUntil),
}))
mockNuxtImport('useManagerDeviceToken', () => () => useManagerDeviceTokenMock())

let useAlarmWatch: typeof import('~/composables/useAlarmWatch').useAlarmWatch

async function settle() {
  await nextTick()
  await flushPromises()
}

describe('useAlarmWatch — 運行管理者の鍵のトークンの先取り', () => {
  beforeEach(async () => {
    isConnected = ref(false)
    enabled.value = true
    backoffUntil.value = 0
    getManagerJwt.mockReset()
    getManagerJwt.mockResolvedValue('manager.jwt')
    useManagerDeviceTokenMock.mockClear()
    vi.resetModules()
    useAlarmWatch = (await import('~/composables/useAlarmWatch')).useAlarmWatch
  })

  it('警告デバイスが繋がったら 1 回取りに行く。繋がっていないあいだは取りに行かない', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    await settle()
    expect(getManagerJwt).not.toHaveBeenCalled()

    isConnected.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('始めた時点で既に繋がっていれば、そのとき 1 回取りに行く', async () => {
    isConnected.value = true
    const [, app] = withSetup(() => useAlarmWatch())
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('切れて繋がり直したら、もう 1 回取りに行く (切れたときは取りに行かない)', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    isConnected.value = false
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)

    isConnected.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('★ 取れなかったら、抑止の期限を先取りの前の値へ戻す (後続の本物の要求を遅らせない)', async () => {
    backoffUntil.value = 1234
    getManagerJwt.mockImplementation(async () => {
      // 本物は失敗すると 60 秒の抑止を立てて null を返す
      backoffUntil.value = 999_999
      return null
    })
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()

    expect(getManagerJwt).toHaveBeenCalledTimes(1)
    expect(backoffUntil.value).toBe(1234)
    app.unmount()
  })

  it('取れたときは抑止の期限に触らない', async () => {
    backoffUntil.value = 1234
    getManagerJwt.mockImplementation(async () => {
      backoffUntil.value = 5678
      return 'manager.jwt'
    })
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()

    expect(backoffUntil.value).toBe(5678)
    app.unmount()
  })

  it('取得が例外で落ちても外へ出さず、次に繋がったときはまた取りに行く', async () => {
    getManagerJwt.mockRejectedValueOnce(new Error('boom'))
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)

    isConnected.value = false
    await settle()
    isConnected.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it('composable の用意そのものが落ちても外へ出さない', async () => {
    useManagerDeviceTokenMock.mockImplementationOnce(() => { throw new Error('no runtime config') })
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    expect(getManagerJwt).not.toHaveBeenCalled()
    app.unmount()
  })

  it('設定を off にして止めた後は、繋がっても取りに行かない。on に戻せばまた見張る', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    enabled.value = false
    await settle()

    isConnected.value = true
    await settle()
    expect(getManagerJwt).not.toHaveBeenCalled()

    // 始め直した時点で繋がっているので、そのとき 1 回
    enabled.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('2 つ目の呼び出しがあっても見張りは 1 つ (繋がって取りに行くのは 1 回)', async () => {
    const [, first] = withSetup(() => useAlarmWatch())
    const [, second] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)
    first.unmount()
    second.unmount()
  })

  it('トップ画面が unmount されても見張りは続く (止めるのは設定 off だけ)', async () => {
    const [, app] = withSetup(() => useAlarmWatch())
    app.unmount()

    isConnected.value = true
    await settle()
    expect(getManagerJwt).toHaveBeenCalledTimes(1)
  })

  it('Web Serial の設定が未設定の席では見張らない', async () => {
    enabled.value = null
    const [, app] = withSetup(() => useAlarmWatch())
    isConnected.value = true
    await settle()
    expect(getManagerJwt).not.toHaveBeenCalled()
    app.unmount()
  })
})
