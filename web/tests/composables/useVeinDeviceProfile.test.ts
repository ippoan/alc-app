import { beforeEach, describe, expect, it, vi } from 'vitest'

const posted: unknown[] = []
const judged = vi.fn()
vi.mock('~/utils/api', () => ({
  postVeinAuthShotJudged: (shot: unknown, scope: unknown) => {
    posted.push({ shot, scope })
    return judged()
  },
}))
vi.mock('~/utils/vein-db', () => ({
  loadVeinModuleEntries: async () => [
    { employeeId: 'emp-a', moduleId: 10, updatedAt: 't', approved: true },
    { employeeId: 'emp-b', moduleId: 11, updatedAt: 't', approved: true },
  ],
}))

const { useVeinDeviceProfile, VEIN_PROFILE_RELEASE_MS } = await import('~/composables/useVeinDeviceProfile')
const { recordVeinLine } = await import('~/utils/vein-line-log')

const CAPLOG = 'VEIN CAPLOG 0-Gray:155 | [0]-Ir:23,40 Gray:60 | XG_Create:0,973 | 0-Gray:67 | [0]-Ir:60,40 Gray:97 | XG_Create:0,733,126'
const RECORD = new Uint8Array([1, 2, 3])

function port(results: Array<{ id: number | null; record: Uint8Array | null } | Error>) {
  const queue = [...results]
  return {
    identifyKeep: vi.fn(async (onAgain?: () => void) => {
      onAgain?.()
      recordVeinLine(CAPLOG)
      const next = queue.shift()!
      if (next instanceof Error) throw next
      return { ...next, score: 70, thresholds: [60, 67, 80], firmware: '0.1.8+abc' }
    }),
  }
}

beforeEach(() => {
  posted.length = 0
  judged.mockReset()
})

describe('useVeinDeviceProfile', () => {
  it('回数分だけ撮って送り、モジュール・サーバーの判定・ずれ・明るさを 1 回ずつ並べる', async () => {
    judged
      .mockResolvedValueOnce({ result: 'match', scores: [60, 61, 80], rule: 'A', shift: { entry: 1, dx: -3, dy: 1, overlap: 700, overlap0: 600 } })
      .mockResolvedValueOnce({ result: 'nomatch', scores: [40, 41, 50], rule: null, shift: null })
      .mockResolvedValueOnce({ result: 'match', scores: [58, 59, 76], rule: 'C', shift: { entry: 2, dx: -5, dy: 3, overlap: 650, overlap0: 500 } })
    const p = port([{ id: 10, record: RECORD }, { id: null, record: RECORD }, { id: 11, record: RECORD }])
    const sleeps: number[] = []
    const m = useVeinDeviceProfile({ port: p, scope: 'bp-station', sleep: async (ms) => { sleeps.push(ms) } })

    await m.run('emp-a', 3)

    expect(p.identifyKeep).toHaveBeenCalledTimes(3)
    // 1 回ごとに間を置く (最後の回の後は置かない)
    expect(sleeps).toEqual([VEIN_PROFILE_RELEASE_MS, VEIN_PROFILE_RELEASE_MS])
    expect(m.shots.value.map(s => s.module)).toEqual(['self', 'none', 'other'])
    expect(m.shots.value.map(s => s.server)).toEqual(['match', 'nomatch', 'match'])
    expect(m.shots.value[0]).toMatchObject({ n: 1, scores: [60, 61, 80], rule: 'A', dx: -3, dy: 1, overlap: 700, cap: { recordGray: 60, matchGray: 97 }, error: null })
    expect(m.shots.value[1]!.dx).toBeNull()
    // 送る中身: 選んだ乗務員・撮った記録・モジュールの判定・鍵
    expect(posted[0]).toMatchObject({ shot: { employee_id: 'emp-a', shot: RECORD, module: { result: 'IDENTIFIED', slot: 10, hit: 'self', score: 70 }, firmware: '0.1.8+abc' }, scope: 'bp-station' })
    expect(posted[1]).toMatchObject({ shot: { module: { result: 'NOMATCH', slot: null, hit: 'none' } } })
    expect(posted[2]).toMatchObject({ shot: { module: { hit: 'other' } } })
    expect(m.profile.value).toMatchObject({ shots: 3, moduleSelf: 1, serverMatch: 2, dx: { n: 2, mean: -4 } })
    expect(m.busy.value).toBe(false)
    expect(m.guide.value).toBeNull()
  })

  it('記録が届かない・サーバーが判定を返さない・読み取りの失敗は、その回のメモにして続ける', async () => {
    judged.mockResolvedValueOnce(null)
    const p = port([{ id: 10, record: null }, { id: 10, record: RECORD }, new Error('TIMEOUT')])
    const m = useVeinDeviceProfile({ port: p, sleep: async () => {} })

    await m.run('emp-a', 3)

    expect(m.shots.value.map(s => s.error)).toEqual([
      '撮った記録が届きませんでした (古いファーム)',
      'サーバーが判定を返しませんでした (認証ログの対象外のテナント)',
      'TIMEOUT',
    ])
    // 記録が無い回は送らない
    expect(posted).toHaveLength(1)
    expect(m.shots.value[0]!.module).toBe('self')
    expect(m.shots.value[0]!.cap?.matchGray).toBe(97)
  })

  it('サーバーが判定できなかった回は理由を出す (承認済みの記録が無い = 承認待ち)', async () => {
    judged
      .mockResolvedValueOnce({ result: 'error', scores: null, rule: null, shift: null, error: 'no_approved_record' })
      .mockResolvedValueOnce({ result: 'error', scores: null, rule: null, shift: null, error: 'decrypt_failed' })
    const p = port([{ id: 10, record: RECORD }, { id: 10, record: RECORD }])
    const { VEIN_PROFILE_NO_APPROVED } = await import('~/composables/useVeinDeviceProfile')
    const m = useVeinDeviceProfile({ port: p, sleep: async () => {} })
    await m.run('emp-a', 2)
    expect(m.shots.value.map(s => s.error)).toEqual([VEIN_PROFILE_NO_APPROVED, 'サーバーの判定がエラーでした (decrypt_failed)'])
    expect(m.shots.value[0]!.server).toBe('error')
  })

  it('止めると、今の回が終わったところで終わる', async () => {
    judged.mockResolvedValue({ result: 'match', scores: [60, 60, 80], rule: 'A', shift: null })
    const p = port([{ id: 10, record: RECORD }, { id: 10, record: RECORD }, { id: 10, record: RECORD }])
    const m = useVeinDeviceProfile({ port: p, sleep: async () => { m.stop() } })

    await m.run('emp-a', 3)

    expect(m.shots.value).toHaveLength(1)
    expect(p.identifyKeep).toHaveBeenCalledTimes(1)
  })

  it('実行中にもう一度呼んでも重ねて走らない', async () => {
    judged.mockResolvedValue(null)
    let release!: () => void
    const p = { identifyKeep: vi.fn(() => new Promise<{ id: null; record: null }>((r) => { release = () => r({ id: null, record: null }) })) }
    const m = useVeinDeviceProfile({ port: p, sleep: async () => {} })
    const first = m.run('emp-a', 1)
    await Promise.resolve()
    expect(m.busy.value).toBe(true)
    expect(m.guide.value).toBe('place')
    await m.run('emp-a', 1)
    expect(p.identifyKeep).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(m.busy.value).toBe(false)
  })
})
