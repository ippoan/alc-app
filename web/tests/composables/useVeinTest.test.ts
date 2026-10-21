import { describe, it, expect, vi, beforeEach } from 'vitest'

const diag = vi.hoisted(() => ({ appendDiag: vi.fn() }))
vi.mock('~/utils/serialDiagLog', () => diag)
const db = vi.hoisted(() => ({ clearVeinTemplates: vi.fn(async () => {}) }))
vi.mock('~/utils/vein-db', () => db)
const identify = vi.hoisted(() => ({ resetVeinSyncClock: vi.fn() }))
vi.mock('~/utils/vein-identify', () => identify)

import {
  FINGER_POLL_MS,
  FINGER_WAIT_MS,
  VERIFY_SETTLE_MS,
  VEIN_TEST_ID,
  parseVerifyReply,
  useVeinTest,
} from '~/composables/useVeinTest'

// 指静脈の確認タブのロジック (Refs ippoan/alc-app#436)。
// request は行ごとに応答を返す台本。生体データ相当の長い hex は fixture に置かない

type Reply = string | Error
let script: Array<[string, Reply | (() => Reply)]>
let sent: string[]
const sleeps: number[] = []

function make(over: { now?: () => number } = {}) {
  const request = vi.fn(async (line: string) => {
    sent.push(line)
    const i = script.findIndex(([l]) => l === line)
    if (i === -1) throw new Error(`台本に無い行: ${line}`)
    const [, r0] = script[i]!
    script.splice(i, 1)
    const r = typeof r0 === 'function' ? r0() : r0
    if (r instanceof Error) throw r
    return r
  })
  const t = useVeinTest({
    request,
    sleep: async (ms) => { sleeps.push(ms) },
    ...over,
  })
  return { t, request }
}

const CLEAR = `VEIN TEST CLEAR ${VEIN_TEST_ID}`
const CLEARED = `VEIN TEST CLEARED ${VEIN_TEST_ID}`
const ENROLL = `VEIN TEST ENROLL ${VEIN_TEST_ID}`
const ENROLLED = `VEIN TEST ENROLLED ${VEIN_TEST_ID}`
const VERIFY = `VEIN TEST VERIFY ${VEIN_TEST_ID}`
const FINGER = 'VEIN FINGER?'

beforeEach(() => {
  script = []
  sent = []
  sleeps.length = 0
  diag.appendDiag.mockClear()
  db.clearVeinTemplates.mockClear()
  identify.resetVeinSyncClock.mockClear()
})

describe('parseVerifyReply', () => {
  it('RC と DATA の先頭 8 バイトに分ける (大文字にする)', () => {
    expect(parseVerifyReply('VEIN TEST VERIFY 2 RC=00 DATA=0102030405060708090a0b')).toEqual({ rc: '00', data: '0102030405060708' })
  })
  it('DATA が空でもよい', () => {
    expect(parseVerifyReply('VEIN TEST VERIFY 2 RC=01 DATA=')).toEqual({ rc: '01', data: '' })
  })
  it('形が違えば null', () => {
    expect(parseVerifyReply('VEIN TEST VERIFY 2')).toBeNull()
  })
})

describe('登録', () => {
  it('★ CLEAR → 指を待つ → ENROLL の順に送る。待つあいだは「置いて」を出す', async () => {
    const { t } = make()
    const guides: string[] = []
    script = [
      [CLEAR, CLEARED],
      [FINGER, () => { guides.push(t.guide.value); return 'VEIN FINGER 0' }],
      [FINGER, () => { guides.push(t.guide.value); return 'VEIN FINGER 1' }],
      [ENROLL, ENROLLED],
    ]
    await t.enroll()
    expect(sent).toEqual([CLEAR, FINGER, FINGER, ENROLL])
    expect(guides).toEqual(['place', 'place'])
    expect(sleeps).toEqual([FINGER_POLL_MS])
    expect(t.result.value?.kind).toBe('enrolled')
    expect(t.error.value).toBeNull()
    expect(t.guide.value).toBe('none')
    expect(t.busy.value).toBe(false)
  })

  it('未登録の ID の CLEAR が失敗しても登録は続ける', async () => {
    const { t } = make()
    script = [[CLEAR, new Error('ERR VEIN RC=01')], [FINGER, 'VEIN FINGER 1'], [ENROLL, ENROLLED]]
    await t.enroll()
    expect(t.result.value?.kind).toBe('enrolled')
  })

  it('ENROLL の失敗は理由をそのまま出す', async () => {
    const { t } = make()
    script = [[CLEAR, CLEARED], [FINGER, 'VEIN FINGER 1'], [ENROLL, new Error('ERR VEIN TIMEOUT')]]
    await t.enroll()
    expect(t.error.value).toBe('ERR VEIN TIMEOUT')
    expect(t.result.value).toBeNull()
    expect(t.busy.value).toBe(false)
  })

  it('指が上限まで置かれなければ諦める', async () => {
    let clock = 0
    const { t } = make({ now: () => clock })
    script = [[CLEAR, CLEARED]]
    for (let i = 0; i < 200; i++) script.push([FINGER, () => { clock += FINGER_WAIT_MS / 2; return 'VEIN FINGER 0' }])
    await t.enroll()
    expect(t.error.value).toBe('指が置かれませんでした')
    expect(sent).not.toContain(ENROLL)
  })
})

describe('照合', () => {
  it('★ 指が離れる → 置かれる → 0.7 秒 → VERIFY。一致を数える', async () => {
    const { t } = make()
    const guides: string[] = []
    script = [
      [FINGER, () => { guides.push(t.guide.value); return 'VEIN FINGER 1' }],
      [FINGER, () => { guides.push(t.guide.value); return 'VEIN FINGER 0' }],
      [FINGER, () => { guides.push(t.guide.value); return 'VEIN FINGER 1' }],
      [VERIFY, 'VEIN TEST VERIFY 2 RC=00 DATA=0102030405060708090A0B0C'],
    ]
    await t.verify()
    expect(sent).toEqual([FINGER, FINGER, FINGER, VERIFY])
    expect(guides).toEqual(['release', 'release', 'place'])
    expect(sleeps).toEqual([FINGER_POLL_MS, VERIFY_SETTLE_MS])
    expect(t.result.value).toEqual({ kind: 'match', text: '一致しました (RC=00 DATA=0102030405060708)' })
    expect(t.summary.value).toBe('一致 1 / 試行 1')
  })

  it('RC=01 は一致せず。試行だけ増える。DATA は 8 バイトまで', async () => {
    const { t } = make()
    script = [[FINGER, 'VEIN FINGER 0'], [FINGER, 'VEIN FINGER 1'], [VERIFY, 'VEIN TEST VERIFY 2 RC=01 DATA=09FFEEDDCCBBAA99887766']]
    await t.verify()
    expect(t.result.value).toEqual({ kind: 'mismatch', text: '一致しませんでした (RC=01 DATA=09FFEEDDCCBBAA99)' })
    expect(t.summary.value).toBe('一致 0 / 試行 1')
  })

  it('それ以外の RC はそのまま出す', async () => {
    const { t } = make()
    script = [[FINGER, 'VEIN FINGER 0'], [FINGER, 'VEIN FINGER 1'], [VERIFY, 'VEIN TEST VERIFY 2 RC=0B DATA=']]
    await t.verify()
    expect(t.result.value).toEqual({ kind: 'other', text: 'RC=0B DATA=' })
  })

  it('形の読めない応答は切って出す', async () => {
    const { t } = make()
    script = [[FINGER, 'VEIN FINGER 0'], [FINGER, 'VEIN FINGER 1'], [VERIFY, 'VEIN TEST VERIFY 2 ???']]
    await t.verify()
    expect(t.result.value?.kind).toBe('other')
    expect(t.result.value?.text).toContain('応答の形が読めません')
  })

  it('指が離れないままなら諦める (VERIFY は送らない)', async () => {
    let clock = 0
    const { t } = make({ now: () => clock })
    for (let i = 0; i < 200; i++) script.push([FINGER, () => { clock += FINGER_WAIT_MS / 2; return 'VEIN FINGER 1' }])
    await t.verify()
    expect(t.error.value).toBe('指が離れませんでした')
    expect(t.summary.value).toBe('一致 0 / 試行 0')
  })

  it('VERIFY の ERR は error に出し、試行には数える', async () => {
    const { t } = make()
    script = [[FINGER, 'VEIN FINGER 0'], [FINGER, 'VEIN FINGER 1'], [VERIFY, new Error('ERR VEIN UNSUPPORTED')]]
    await t.verify()
    expect(t.error.value).toBe('ERR VEIN UNSUPPORTED')
    expect(t.summary.value).toBe('一致 0 / 試行 1')
  })

  it('Error 以外が投げられても文字列にして出す', async () => {
    const request = vi.fn(async () => { throw 'weird' })
    const t = useVeinTest({ request, sleep: async () => {} })
    await t.clearModule()
    expect(t.error.value).toBe('weird')
  })
})

describe('既定の待ち (sleep を差し替えない)', () => {
  it('実時間の setTimeout で待ってから VERIFY を送る', async () => {
    vi.useFakeTimers()
    try {
      const replies = ['VEIN FINGER 0', 'VEIN FINGER 1', 'VEIN TEST VERIFY 2 RC=00 DATA=']
      const request = vi.fn(async () => replies.shift()!)
      const t = useVeinTest({ request })
      const done = t.verify()
      await vi.advanceTimersByTimeAsync(VERIFY_SETTLE_MS)
      await done
      expect(t.result.value?.kind).toBe('match')
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('消す / 手元の写しを消す', () => {
  it('消す: CLEAR 2 だけを送る', async () => {
    const { t } = make()
    script = [[CLEAR, CLEARED]]
    await t.clearModule()
    expect(sent).toEqual([CLEAR])
    expect(t.result.value?.kind).toBe('cleared')
  })

  it('★ 手元の写しを消す: vein-db の clear と同期時計のリセットを呼び、モジュールには何も送らない', async () => {
    const { t, request } = make()
    await t.clearLocalCopy()
    expect(db.clearVeinTemplates).toHaveBeenCalledTimes(1)
    expect(identify.resetVeinSyncClock).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(t.result.value?.kind).toBe('local-cleared')
  })

  it('clearLocal を差し替えられる / 失敗は error に出る', async () => {
    const clearLocal = vi.fn(async () => { throw new Error('idb 失敗') })
    const t = useVeinTest({ request: vi.fn(), clearLocal })
    await t.clearLocalCopy()
    expect(clearLocal).toHaveBeenCalled()
    expect(t.error.value).toBe('idb 失敗')
  })
})

describe('送信の共通ルール', () => {
  it('実行中は次の操作を受けない (1 件ずつ)', async () => {
    const { t, request } = make()
    let release!: () => void
    script = [[CLEAR, () => 'x' as Reply]]
    request.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve(CLEARED) }))
    const first = t.clearModule()
    expect(t.busy.value).toBe(true)
    await t.verify()
    expect(request).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(t.busy.value).toBe(false)
  })

  it('★ 「既に応答待ち」のときだけ間を置いて呼び直す', async () => {
    const t = (() => {
      let n = 0
      const request = vi.fn(async (line: string) => {
        sent.push(line)
        if (n++ < 2) throw new Error('request(timecard): 既に応答待ちです')
        return CLEARED
      })
      return useVeinTest({ request, sleep: async (ms) => { sleeps.push(ms) } })
    })()
    await t.clearModule()
    expect(sent).toEqual([CLEAR, CLEAR, CLEAR])
    expect(t.result.value?.kind).toBe('cleared')
  })

  it('allowlist を通らない行は送らない (共有の送信関数が拒む)', async () => {
    // 試験用 ID の行は固定なので通常は起きないが、request に届かないことを関数側で保証している
    const request = vi.fn(async () => CLEARED)
    const t = useVeinTest({ request, sleep: async () => {} })
    await t.clearModule()
    expect(request).toHaveBeenCalledWith(CLEAR, CLEARED, expect.any(Number), 'ERR ')
  })

  it('★ タブを離れたら (dispose) 以後の行は送らない', async () => {
    const { t, request } = make()
    t.dispose()
    await t.verify()
    expect(request).not.toHaveBeenCalled()
    expect(t.error.value).toBe('タブを離れたので中止しました')
  })

  it('登録の途中で離れたら、CLEAR の失敗を無視せず中止する', async () => {
    const { t } = make()
    script = [[CLEAR, () => { t.dispose(); return new Error('ERR VEIN RC=01') }]]
    await t.enroll()
    expect(t.error.value).toBe('タブを離れたので中止しました')
    expect(sent).toEqual([CLEAR])
  })

  it('★ 送った行と結果を診断ログに貯める。VERIFY の DATA は 8 バイトに切った形', async () => {
    const { t } = make()
    script = [[FINGER, 'VEIN FINGER 0'], [FINGER, 'VEIN FINGER 1'], [VERIFY, 'VEIN TEST VERIFY 2 RC=00 DATA=0102030405060708090A0B0C0D0E0F']]
    await t.verify()
    const logged = diag.appendDiag.mock.calls.map(c => c[0] as string)
    expect(logged).toContain(`vein-test 送 ${VERIFY}`)
    expect(logged).toContain('vein-test 受 VEIN TEST VERIFY 2 RC=00 DATA=0102030405060708')
    expect(logged.join('\n')).not.toContain('090A0B')
    expect(t.lines.value.join('\n')).not.toContain('090A0B')
  })

  it('画面の行は最後の 20 行まで', async () => {
    const { t } = make()
    for (let i = 0; i < 12; i++) script.push([CLEAR, CLEARED])
    for (let i = 0; i < 12; i++) await t.clearModule()
    expect(t.lines.value).toHaveLength(20)
  })
})
