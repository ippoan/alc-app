// 血圧を待っている間の BLE の生存確認 (BLE PING)。止まった・返事が無いを画面と診断ログに出す
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, effectScope, nextTick } from 'vue'
import { useBleWatch, parseBlePong, BLE_WATCH_INTERVAL_MS, BLE_WATCH_MAX_MS } from '~/composables/useBleWatch'
import { readDiag } from '~/utils/serialDiagLog'

function setup(reply: (line: string) => Promise<string>, connected = true) {
  const isConnected = ref(connected)
  const active = ref(false)
  const request = vi.fn((line: string) => reply(line))
  const scope = effectScope()
  const watch = scope.run(() => useBleWatch({ isConnected, request }, active))!
  return { isConnected, active, request, watch, scope }
}

const pong = (stage: string, age: number, stuck: 0 | 1) => `BLE PONG run=1 stage=${stage} age=${age} stuck=${stuck}`

describe('useBleWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('parseBlePong は段・時間・止まりを読む (形が違えば null)', () => {
    expect(parseBlePong(pong('connect', 1200, 0))).toEqual({ stage: 'connect', ageMs: 1200, stuck: false })
    expect(parseBlePong('BLE PONG run=1 stage=- age=- stuck=0')).toEqual({ stage: '-', ageMs: null, stuck: false })
    expect(parseBlePong('BLE PONG')).toBeNull()
  })

  it('測定を待っていない間は送らない。待ち始めたら 1 秒ごとに BLE PING を送る', async () => {
    const h = setup(async () => pong('scan', 100, 0))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.request).not.toHaveBeenCalled()

    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 2)
    expect(h.request).toHaveBeenCalledTimes(3)
    expect(h.request).toHaveBeenCalledWith('BLE PING', 'BLE PONG', 800)
    expect(h.watch.state.value).toBe('ok')

    h.active.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.request).toHaveBeenCalledTimes(3)
    h.scope.stop()
  })

  it('★ stuck=1 なら止まっていると出す。戻れば ok。診断ログは集計の 1 行だけ', async () => {
    let reply = pong('connect', 31_000, 1)
    const h = setup(async () => reply)
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 2)
    expect(h.watch.state.value).toBe('stuck')
    expect(h.watch.stuckStage.value).toBe('connect')

    reply = pong('scan', 10, 0)
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS)
    expect(h.watch.state.value).toBe('ok')
    expect(h.watch.stuckStage.value).toBeNull()

    expect(readDiag()).toEqual([])
    h.scope.stop()
    expect(readDiag().map(l => l.replace(/^\S+ /, ''))).toEqual([
      'dev BLE ping sent=4 ok=4 busy=0 fail=0 stuck=3 max_age=31000 stages=connect,scan',
    ])
  })

  it('★ 返事が 3 回続けて無ければ「返事が無い」。応答待ちのぶつかりは数えない', async () => {
    let fail: Error = new Error('request(vein): 既に応答待ちです')
    const h = setup(async () => {
      throw fail
    })
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 4)
    expect(h.watch.state.value).toBe('ok')

    fail = new Error('request(vein): BLE PING の応答がありません')
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 2)
    expect(h.watch.state.value).toBe('ok')
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS)
    expect(h.watch.state.value).toBe('no-reply')
    h.scope.stop()
  })

  it('★ 待ち終えたら、その間の集計を 1 行残す (返事が来ていたかをログで確かめられる)', async () => {
    let n = 0
    const h = setup(async () => {
      n += 1
      if (n === 2) throw new Error('request(vein): 既に応答待ちです')
      if (n === 3) throw new Error('request(vein): BLE PING の応答がありません')
      return n === 4 ? pong('connect', 1_500, 0) : pong('scan', 200, 0)
    })
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 4)
    h.active.value = false
    await nextTick()

    expect(readDiag().map(l => l.replace(/^\S+ /, ''))).toEqual([
      'dev BLE ping sent=5 ok=3 busy=1 fail=1 stuck=0 max_age=1500 stages=scan,connect',
    ])
    // 次に待ち始めたときは数え直す (送っていない回は残さない)
    h.active.value = true
    await nextTick()
    h.active.value = false
    await nextTick()
    expect(readDiag()).toHaveLength(2)
    h.scope.stop()
  })

  it('★ 2 分で打ち切り、集計を残す。打ち切った後は送らない', async () => {
    const h = setup(async () => pong('scan', 100, 0))
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_MAX_MS)
    const sent = h.request.mock.calls.length
    expect(readDiag().map(l => l.replace(/^\S+ /, ''))).toEqual([
      `dev BLE ping sent=${sent} ok=${sent} busy=0 fail=0 stuck=0 max_age=100 stages=scan`,
    ])
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 5)
    expect(h.request).toHaveBeenCalledTimes(sent)
    h.scope.stop()
  })

  it('旧ファームは unsupported とだけ残す。形の違う応答は段に数えない', async () => {
    const h = setup(async () => {
      throw new Error('ERR BLE: PAIR が必要です')
    })
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS)
    h.scope.stop()
    expect(readDiag().map(l => l.replace(/^\S+ /, ''))).toEqual(['dev BLE ping unsupported'])

    localStorage.clear()
    const g = setup(async () => 'BLE PONG')
    g.active.value = true
    await nextTick()
    g.active.value = false
    await nextTick()
    expect(readDiag().map(l => l.replace(/^\S+ /, ''))).toEqual([
      'dev BLE ping sent=1 ok=1 busy=0 fail=0 stuck=0 max_age=- stages=-',
    ])
    g.scope.stop()
  })

  it('旧ファーム (ERR BLE) はその接続のあいだ送らない。つなぎ直したらまた送る', async () => {
    const h = setup(async () => {
      throw new Error('ERR BLE: PAIR が必要です')
    })
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 3)
    expect(h.request).toHaveBeenCalledTimes(1)
    expect(h.watch.state.value).toBe('ok')

    h.isConnected.value = false
    await nextTick()
    h.isConnected.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS)
    expect(h.request).toHaveBeenCalledTimes(2)
    h.scope.stop()
  })

  it('つながっていない間は送らない。形の違う応答は状態を変えない', async () => {
    const h = setup(async () => 'BLE PONG', false)
    h.active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS * 2)
    expect(h.request).not.toHaveBeenCalled()

    h.isConnected.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(BLE_WATCH_INTERVAL_MS)
    expect(h.request).toHaveBeenCalled()
    expect(h.watch.state.value).toBe('ok')
    h.scope.stop()
  })
})
