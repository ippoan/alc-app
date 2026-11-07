import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import type { ApiEmployee } from '~/types'
import type { VeinModuleEntry } from '~/utils/vein-db'

// 照合を端末のモジュールに任せる経路 (M-b、Refs ippoan/alc-app#436)。
// モジュールの ID (10〜100) ↔ 乗務員の対応表で引き、承認済みだけを本人確認にする。
// 従業員はすべて合成値

const api = vi.hoisted(() => ({
  getEmployeeById: vi.fn(),
  getEmployees: vi.fn(),
  getVeinModuleTemplate: vi.fn(),
  getVeinModuleTemplates: vi.fn(),
  getPendingVeinModuleTemplates: vi.fn(),
  rotateVeinModuleDeviceRecord: vi.fn(),
  getVeinAuthLogEnabled: vi.fn(),
  postVeinAuthShot: vi.fn(),
}))
vi.mock('~/utils/api', () => api)

const db = vi.hoisted(() => ({
  loadVeinModuleEntries: vi.fn(),
  putVeinModuleEntry: vi.fn(),
  deleteVeinModuleEntry: vi.fn(),
}))
vi.mock('~/utils/vein-db', () => db)

let mod: typeof import('~/utils/vein-module')

const EMP = { id: 'emp-1', name: '試験 一郎' } as ApiEmployee

function entry(employeeId: string, moduleId: number, overrides: Partial<VeinModuleEntry> = {}): VeinModuleEntry {
  return { employeeId, moduleId, updatedAt: 'v1', approved: true, ...overrides }
}

function port(connected = true) {
  return {
    isConnected: ref(connected),
    syncWrite: vi.fn(async () => {}),
    syncClear: vi.fn(async () => {}),
  }
}

beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.resetModules()
  mod = await import('~/utils/vein-module')
  db.loadVeinModuleEntries.mockResolvedValue([])
  db.putVeinModuleEntry.mockResolvedValue(undefined)
  db.deleteVeinModuleEntry.mockResolvedValue(undefined)
  // 承認待ちは既定で誰もいない (native の人を消すかの確認に使う)
  api.getPendingVeinModuleTemplates.mockReset().mockResolvedValue([])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usesVeinModule', () => {
  it('★ すべての端末で使う (開発用の印にも測定台にも依らない)', () => {
    expect(mod.usesVeinModule()).toBe(true)
  })
})

describe('allocateVeinModuleId', () => {
  it('既に置いてあればその ID、無ければ 10 から空いている最小の ID', () => {
    const entries = [entry('a', 10), entry('b', 12)]
    expect(mod.allocateVeinModuleId(entries, 'b')).toBe(12)
    expect(mod.allocateVeinModuleId(entries, 'c')).toBe(11)
    expect(mod.allocateVeinModuleId([], 'c')).toBe(mod.VEIN_MODULE_ID_MIN)
  })

  it('10〜100 が埋まっていれば null', () => {
    const full = Array.from({ length: 91 }, (_, i) => entry(`e${i}`, 10 + i))
    expect(mod.allocateVeinModuleId(full, 'new')).toBeNull()
  })
})

describe('identifyVeinModuleEmployee', () => {
  it('不一致 (null)・対応表に無い ID は miss', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 10, { approved: false })])
    expect(await mod.identifyVeinModuleEmployee(null)).toEqual({ kind: 'miss' })
    expect(await mod.identifyVeinModuleEmployee(11)).toEqual({ kind: 'miss' })
    expect(api.getEmployeeById).not.toHaveBeenCalled()
  })

  it('★ 承認待ちの ID は pending (本人確認にしない)。名前が引けなければ null', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 10, { approved: false })])
    api.getEmployeeById.mockResolvedValue(EMP)
    expect(await mod.identifyVeinModuleEmployee(10)).toEqual({ kind: 'pending', employeeId: 'emp-1', name: EMP.name })
    api.getEmployeeById.mockRejectedValue(new Error('500'))
    expect(await mod.identifyVeinModuleEmployee(10)).toEqual({ kind: 'pending', employeeId: 'emp-1', name: null })
  })

  it('承認済みの ID は乗務員を引いて hit', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 10)])
    api.getEmployeeById.mockResolvedValue(EMP)
    expect(await mod.identifyVeinModuleEmployee(10)).toEqual({ kind: 'hit', employee: EMP })
    expect(api.getEmployeeById).toHaveBeenCalledWith('emp-1', 'default')
  })

  it('鍵の種類を渡すと、その鍵で乗務員を引く (オフラインの一覧も同じ鍵)', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 10)])
    api.getEmployeeById.mockResolvedValue(EMP)
    expect(await mod.identifyVeinModuleEmployee(10, 'manager-device')).toEqual({ kind: 'hit', employee: EMP })
    expect(api.getEmployeeById).toHaveBeenLastCalledWith('emp-1', 'manager-device')

    api.getEmployeeById.mockRejectedValue(new TypeError('Failed to fetch'))
    api.getEmployees.mockResolvedValue([EMP])
    expect(await mod.identifyVeinModuleEmployee(10, 'manager-device')).toEqual({ kind: 'hit', employee: EMP })
    expect(api.getEmployees).toHaveBeenLastCalledWith('manager-device')
  })

  it('ネットワークで失敗したら手元の乗務員一覧から引く。居なければ理由を返す', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 10)])
    api.getEmployeeById.mockRejectedValue(new TypeError('Failed to fetch'))
    api.getEmployees.mockResolvedValue([EMP])
    expect(await mod.identifyVeinModuleEmployee(10)).toEqual({ kind: 'hit', employee: EMP })

    api.getEmployees.mockResolvedValue([])
    const outcome = await mod.identifyVeinModuleEmployee(10)
    expect(outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('乗務員の情報が手元にありません') })
  })

  it('ほかの失敗は理由を返す (Error でないものも)', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 10)])
    api.getEmployeeById.mockRejectedValue(new Error('API エラー (500)'))
    expect(await mod.identifyVeinModuleEmployee(10)).toEqual({ kind: 'error', message: '指静脈の照合に失敗しました: API エラー (500)' })
    db.loadVeinModuleEntries.mockRejectedValue('boom')
    expect(await mod.identifyVeinModuleEmployee(10)).toEqual({ kind: 'error', message: '指静脈の照合に失敗しました: boom' })
  })
})

describe('retryOnVeinMiss', () => {
  it('★ 不一致なら 1 回だけやり直し、やり直す前に onRetry を呼んで PC VEIN RETRY を残す', async () => {
    const { snapshotVeinLines } = await import('~/utils/vein-line-log')
    const read = vi.fn<() => Promise<number | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(15)
    const onRetry = vi.fn()
    expect(await mod.retryOnVeinMiss(read, id => id === null, onRetry)).toBe(15)
    expect(read).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(snapshotVeinLines()).toMatch(/ PC VEIN RETRY$/)
  })

  it('当たれば 1 回で終わる。2 回とも不一致なら不一致を返す (3 回目はしない)', async () => {
    const hit = vi.fn(async () => true)
    const onRetry = vi.fn()
    expect(await mod.retryOnVeinMiss(hit, ok => !ok, onRetry)).toBe(true)
    expect(hit).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    const miss = vi.fn(async () => false)
    expect(await mod.retryOnVeinMiss(miss, ok => !ok, onRetry)).toBe(false)
    expect(miss).toHaveBeenCalledTimes(1 + mod.VEIN_NOMATCH_RETRIES)
  })

  it('onRetry が Promise を返すなら、終わるのを待ってからやり直す (機器の案内とやり直しの照合が重ならない)', async () => {
    const order: string[] = []
    const read = vi.fn(async () => { order.push('read'); return order.length > 1 })
    const onRetry = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      order.push('say')
    })
    expect(await mod.retryOnVeinMiss(read, ok => !ok, onRetry)).toBe(true)
    expect(order).toEqual(['read', 'say', 'read'])
  })

  it('照合の失敗 (投げる) はやり直さずそのまま投げる', async () => {
    const read = vi.fn(async () => { throw new Error('TIMEOUT') })
    await expect(mod.retryOnVeinMiss(read, () => true, vi.fn())).rejects.toThrow('TIMEOUT')
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('prepareVeinModuleRecord', () => {
  const B64 = btoa(String.fromCharCode(0xDE, 0xED))

  it('手元の対応表と版が同じなら、書かずにその ID', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15)])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v1' })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(15)
    expect(p.syncWrite).not.toHaveBeenCalled()
    // 使った印 (枠を譲らせる順) を残す
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith({ ...entry('emp-1', 15), source: 'server', lastUsedAt: expect.any(Number) })
  })

  it('★ その 1 人だけを、混ぜずに選んだ記録で頼む (native の設定。鍵も渡す)', async () => {
    api.getVeinModuleTemplate.mockResolvedValue(undefined)
    await mod.prepareVeinModuleRecord(port(), 'emp-1', 'manager-device')
    expect(api.getVeinModuleTemplate).toHaveBeenCalledWith('emp-1', { pick: 'own', scope: 'manager-device' })
    localStorage.setItem('alc-vein-added-finger', 'mixed')
    await mod.prepareVeinModuleRecord(port(), 'emp-1')
    expect(api.getVeinModuleTemplate).toHaveBeenLastCalledWith('emp-1', { pick: undefined, scope: 'default' })
  })

  it('★ 枠が埋まっていたら、一番長く使っていない承認済みの人の枠を譲らせる (承認待ちは譲らせない)', async () => {
    const full = Array.from({ length: 91 }, (_, i) => entry(`x${i}`, 10 + i, { lastUsedAt: 1000 + i }))
    full[5] = entry('pending', 15, { approved: false })
    full[40] = entry('old', 50, { lastUsedAt: 1 })
    full[41] = entry('never', 51)
    db.loadVeinModuleEntries.mockResolvedValue(full)
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v1', source: 'own' })
    const p = port()
    // 使った印の無い人 (0 と見る) が一番古い
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(51)
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('never')
    expect(p.syncWrite).toHaveBeenCalledWith(51, expect.any(Uint8Array))
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 'emp-1', moduleId: 51 }))
  })

  it('★ 端末に無ければ DB の記録を空きへ書き、対応表に承認済みで入れる', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('other', 10)])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v3' })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(11)
    expect(p.syncWrite).toHaveBeenCalledWith(11, expect.any(Uint8Array))
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith({ employeeId: 'emp-1', moduleId: 11, updatedAt: 'v3', approved: true, registeredDeviceId: null, source: 'server', lastUsedAt: expect.any(Number) })
  })

  it('登録した端末をサーバーの値で対応表に入れる', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v3', registered_device_id: 'alarm:0123456789abcdef' })
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBe(10)
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(expect.objectContaining({ registeredDeviceId: 'alarm:0123456789abcdef' }))
  })

  it('版が違えば (承認待ちで置いてあった場合も) 同じ ID に書き直す。古い対応は先に外す', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 20, { approved: false })])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v2' })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(20)
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('emp-1')
    expect(p.syncWrite).toHaveBeenCalledWith(20, expect.any(Uint8Array))
  })

  it('DB に承認済みの記録が無ければ null', async () => {
    api.getVeinModuleTemplate.mockResolvedValue(undefined)
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBeNull()
  })

  it('サーバーに届かなければ、手元の承認済みの ID を使う (無い・承認待ちなら null)', async () => {
    api.getVeinModuleTemplate.mockRejectedValue(new TypeError('Failed to fetch'))
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15)])
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBe(15)
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15, { approved: false })])
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBeNull()
  })

  it('ほかの失敗・ID の空き無し・書き込みの失敗は投げる', async () => {
    api.getVeinModuleTemplate.mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(mod.prepareVeinModuleRecord(port(), 'emp-1')).rejects.toThrow('HTTP 500')
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v1' })
    // 承認待ちばかりで譲らせる人が居ない
    db.loadVeinModuleEntries.mockResolvedValue(Array.from({ length: 91 }, (_, i) => entry(`x${i}`, 10 + i, { approved: false })))
    await expect(mod.prepareVeinModuleRecord(port(), 'emp-1')).rejects.toThrow('モジュールの ID が空いていません')
    db.loadVeinModuleEntries.mockResolvedValue([])
    const p = port()
    p.syncWrite.mockRejectedValue(new Error('WRITE_SEQ'))
    await expect(mod.prepareVeinModuleRecord(p, 'emp-1')).rejects.toThrow('WRITE_SEQ')
    expect(db.putVeinModuleEntry).not.toHaveBeenCalled()
  })
})

describe('syncVeinModule', () => {
  const B64 = btoa(String.fromCharCode(0xDE, 0xED))

  it('★ 書いた記録の種類を、Vein Station の行と同じ溜め場所に PC VEIN RECORD で残す (乗務員の ID は出さない)', async () => {
    const { snapshotVeinLines } = await import('~/utils/vein-line-log')
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'emp-1', record: B64, updated_at: 'v1', composed: true },
        { employee_id: 'emp-2', record: B64, updated_at: 'v1' },
      ],
    })
    expect(await mod.syncVeinModule(port())).toBe(true)
    const lines = snapshotVeinLines().split('\n').map(l => l.replace(/^\S+ /, ''))
    expect(lines).toEqual(['PC VEIN RECORD 10 KIND=composed MODE=native', 'PC VEIN RECORD 11 KIND=server MODE=native'])
    expect(snapshotVeinLines()).not.toContain('emp-')
  })

  it('つながっていないときは何もしない', async () => {
    expect(await mod.syncVeinModule(port(false))).toBe(false)
    expect(api.getVeinModuleTemplates).not.toHaveBeenCalled()
  })

  it('鍵の種類を渡すと、その鍵で承認済みの一覧を取る', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    expect(await mod.syncVeinModule(port(), { scope: 'manager-device' })).toBe(true)
    expect(api.getVeinModuleTemplates).toHaveBeenLastCalledWith('manager-device', 'own')
  })

  it('同期の結果 (書き込み・消去・変更なし・失敗の件数) を [vein] の 1 行で残す。名前は出さない', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    db.loadVeinModuleEntries.mockResolvedValue([entry('same', 11), entry('gone', 13)])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'same', record: B64, updated_at: 'v1' },
        { employee_id: 'new', record: B64, updated_at: 'v1' },
      ],
    })
    expect(await mod.syncVeinModule(port())).toBe(true)
    expect(info).toHaveBeenCalledWith('[vein] モジュール同期 完了 書き込み=1 消去=1 変更なし=1 枠なし=0 失敗=0 対象=2')
    info.mockRestore()
  })

  it('★ 新しい記録は空きへ書き、変わった記録は同じ ID に書き直し、消えた承認済みは消す。承認待ちは残す', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([
      entry('pending-approved', 10, { approved: false }), // この端末で登録 → 承認された
      entry('same', 11), // 変わっていない
      entry('changed', 12), // 版が変わった
      entry('gone', 13), // 一覧から消えた (承認済み)
      entry('pending', 14, { approved: false }), // 承認待ちのまま (一覧に載らない)
    ])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'pending-approved', record: B64, updated_at: 'v1' },
        { employee_id: 'same', record: B64, updated_at: 'v1' },
        { employee_id: 'changed', record: B64, updated_at: 'v2' },
        { employee_id: 'new', record: B64, updated_at: 'v1' },
      ],
    })
    const p = port()
    expect(await mod.syncVeinModule(p)).toBe(true)
    // 既定はキオスクの鍵 (鍵の種類を渡さない)
    expect(api.getVeinModuleTemplates).toHaveBeenLastCalledWith(undefined, 'own')

    expect(p.syncClear).toHaveBeenCalledTimes(1)
    expect(p.syncClear).toHaveBeenCalledWith(13)
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('gone')
    expect(p.syncWrite.mock.calls).toEqual([
      [12, new Uint8Array([0xDE, 0xED])],
      // 消えた人の 13 が空いたので、新しい人はそこへ
      [13, new Uint8Array([0xDE, 0xED])],
    ])
    expect(db.putVeinModuleEntry.mock.calls).toEqual([
      [entry('pending-approved', 10, { registeredDeviceId: null })],
      [entry('changed', 12, { updatedAt: 'v2', registeredDeviceId: null, source: 'server' })],
      [entry('new', 13, { registeredDeviceId: null, source: 'server' })],
    ])
    // 書き直す前に古い版を外す (途中で落ちても古い版を承認済みとして引かない)
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('changed')
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalledWith('pending')
  })

  it('登録した端末をサーバーの値で持つ。版が同じでも端末が変われば書き直さずに対応表だけ合わせる', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([
      entry('same', 10, { registeredDeviceId: 'alarm:0123456789abcdef' }),
      entry('known', 11),
    ])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'same', record: B64, updated_at: 'v1', registered_device_id: 'alarm:0123456789abcdef' },
        { employee_id: 'known', record: B64, updated_at: 'v1', registered_device_id: 'kiosk-1' },
        { employee_id: 'new', record: B64, updated_at: 'v1', registered_device_id: 'kiosk-2' },
      ],
    })
    const p = port()
    expect(await mod.syncVeinModule(p)).toBe(true)
    expect(p.syncWrite.mock.calls.map(c => c[0])).toEqual([12])
    expect(db.putVeinModuleEntry.mock.calls).toEqual([
      [entry('known', 11, { registeredDeviceId: 'kiosk-1' })],
      [entry('new', 12, { registeredDeviceId: 'kiosk-2', source: 'server' })],
    ])
  })

  it('1 人の消す・書く失敗は飛ばして続ける (書けなかった人の ID は空きに戻る)', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('gone', 20), entry('changed', 10)])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'changed', record: B64, updated_at: 'v2' },
        { employee_id: 'new', record: B64, updated_at: 'v1' },
      ],
    })
    const p = port()
    p.syncClear.mockRejectedValue(new Error('RC=01'))
    p.syncWrite.mockRejectedValueOnce(new Error('WRITE_SEQ'))
    expect(await mod.syncVeinModule(p)).toBe(true)
    // 消せなかった人は対応表に残る / changed は書けずに対応表から外れ、その 10 に new が入る
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalledWith('gone')
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('changed')
    expect(p.syncWrite.mock.calls.map(c => c[0])).toEqual([10, 10])
    expect(db.putVeinModuleEntry.mock.calls).toEqual([[entry('new', 10, { registeredDeviceId: null, source: 'server' })]])
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('10〜100 が埋まっていれば新しい人は書かない', async () => {
    const full = Array.from({ length: 91 }, (_, i) => entry(`e${i}`, 10 + i))
    db.loadVeinModuleEntries.mockResolvedValue(full)
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        ...full.map(e => ({ employee_id: e.employeeId, record: B64, updated_at: 'v1' })),
        { employee_id: 'new', record: B64, updated_at: 'v1' },
      ],
    })
    const p = port()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(await mod.syncVeinModule(p)).toBe(true)
    expect(p.syncWrite).not.toHaveBeenCalled()
    // 枠を譲らせるのは免許証で決まったとき (prepareVeinModuleRecord) だけ。同期は飛ばす
    expect(info).toHaveBeenCalledWith(expect.stringContaining('枠なし=1 失敗=0'))
  })

  it('一覧が取れなければ false (投げない)', async () => {
    api.getVeinModuleTemplates.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await mod.syncVeinModule(port())).toBe(false)
    expect(console.warn).toHaveBeenCalled()
  })

  it('ifOlderThanMs: 前回の同期から時間がたっていなければ何もしない。重ねて呼んでも 1 本だけ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    const p = port()
    const first = mod.syncVeinModule(p)
    expect(await mod.syncVeinModule(p)).toBe(false)
    expect(await first).toBe(true)
    expect(await mod.syncVeinModule(p, { ifOlderThanMs: 60_000 })).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(await mod.syncVeinModule(p, { ifOlderThanMs: 60_000 })).toBe(true)
    expect(api.getVeinModuleTemplates).toHaveBeenCalledTimes(2)
  })

  it('一度も同期していなければ ifOlderThanMs があっても動く', async () => {
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    expect(await mod.syncVeinModule(port(), { ifOlderThanMs: 60_000 })).toBe(true)
  })
})

// 「この端末の指を足す」で足した指 (native)。設定が native なら同期・用意が書き換えず、mixed なら書き直す
// (Refs ippoan/alc-app#558)
describe('その場で撮った記録 (native) の扱い', () => {
  const B64 = btoa(String.fromCharCode(0xDE, 0xED))
  const MODE_KEY = 'alc-vein-added-finger'

  it('★ native の設定: 同期はサーバーの版が変わっても native の記録を書き換えない。ほかの人は今までどおり', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('added', 10, { updatedAt: 'v1', native: true }), entry('other', 11)])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'added', record: B64, updated_at: 'v2', composed: true },
        { employee_id: 'other', record: B64, updated_at: 'v2' },
      ],
    })
    const p = port()
    expect(await mod.syncVeinModule(p)).toBe(true)
    expect(p.syncWrite.mock.calls.map(c => c[0])).toEqual([11])
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalledWith('added')
    expect(db.putVeinModuleEntry).not.toHaveBeenCalledWith(expect.objectContaining({ employeeId: 'added' }))
  })

  it('★ native の設定: この端末で登録した記録 (承認待ち) は、サーバーが同じ版を配ったら承認済みにする。版が違えば承認待ちのまま', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([
      entry('mine', 10, { updatedAt: 'v-dev', approved: false, native: true }),
      entry('waiting', 11, { updatedAt: 'v-dev', approved: false, native: true }),
      entry('nodevice', 12, { updatedAt: 'v-dev', approved: false, native: true }),
    ])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [
        { employee_id: 'mine', record: B64, updated_at: 'v-dev', registered_device_id: 'alarm:bp' },
        // この端末の分は承認待ち: サーバーは別の承認済みの記録を配っている
        { employee_id: 'waiting', record: B64, updated_at: 'v-other' },
        // 登録した端末が分からない記録 (古いサーバー)
        { employee_id: 'nodevice', record: B64, updated_at: 'v-dev' },
      ],
    })
    const p = port()
    await mod.syncVeinModule(p)
    expect(p.syncWrite).not.toHaveBeenCalled()
    expect(db.putVeinModuleEntry).toHaveBeenCalledTimes(2)
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(entry('mine', 10, { updatedAt: 'v-dev', approved: true, native: true, registeredDeviceId: 'alarm:bp' }))
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(entry('nodevice', 12, { updatedAt: 'v-dev', approved: true, native: true, registeredDeviceId: null }))
  })

  it('★ native の設定でも、一覧から消えた (承認の取り消し・退職) native の人はモジュールから消す', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('added', 10, { native: true })])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    const p = port()
    await mod.syncVeinModule(p)
    expect(p.syncClear).toHaveBeenCalledWith(10)
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('added')
  })

  it('★ native の人が別の端末で登録し直して承認待ちになっただけなら、モジュールから消さない (指紋互換の部分が消えるため)', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('added', 10, { native: true }), entry('gone', 11)])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    api.getPendingVeinModuleTemplates.mockResolvedValue([{ employee_id: 'added', name: 'x', updated_at: 'v2' }])
    const p = port()
    await mod.syncVeinModule(p, { scope: 'bp-station' })
    expect(api.getPendingVeinModuleTemplates).toHaveBeenCalledWith('bp-station')
    // native でない人は今までどおり消す
    expect(p.syncClear.mock.calls).toEqual([[11]])
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalledWith('added')
  })

  it('★ 承認待ちかを確かめられないときも、native の人は消さずに残す', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('added', 10, { native: true })])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    api.getPendingVeinModuleTemplates.mockRejectedValue(new Error('403'))
    const p = port()
    await mod.syncVeinModule(p)
    expect(p.syncClear).not.toHaveBeenCalled()
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalled()
  })

  it('★ mixed の設定: native の記録は版が同じでも、サーバーが組んだ記録で同じ ID に書き直す (native の印は外れる)', async () => {
    localStorage.setItem(MODE_KEY, 'mixed')
    db.loadVeinModuleEntries.mockResolvedValue([entry('added', 10, { updatedAt: 'v1', native: true })])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [{ employee_id: 'added', record: B64, updated_at: 'v1', composed: true }] })
    const p = port()
    await mod.syncVeinModule(p)
    expect(p.syncWrite).toHaveBeenCalledWith(10, new Uint8Array([0xDE, 0xED]))
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(entry('added', 10, { registeredDeviceId: null, source: 'composed' }))
    expect(db.putVeinModuleEntry.mock.calls[0]![0]).not.toHaveProperty('native')
  })

  it('用意: native の設定なら版が違っても native の記録をそのまま使う', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15, { updatedAt: 'v1', native: true })])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v9' })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(15)
    expect(p.syncWrite).not.toHaveBeenCalled()
  })

  it('用意: mixed の設定なら native の記録は版が同じでも書き直す', async () => {
    localStorage.setItem(MODE_KEY, 'mixed')
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15, { updatedAt: 'v1', native: true })])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v1' })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(15)
    expect(p.syncWrite).toHaveBeenCalledWith(15, new Uint8Array([0xDE, 0xED]))
  })

  it('用意: native でも、承認待ち (approved: false) の記録は使わず書き直す', async () => {
    localStorage.setItem(MODE_KEY, 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15, { native: true, approved: false })])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v1' })
    const p = port()
    await mod.prepareVeinModuleRecord(p, 'emp-1')
    expect(p.syncWrite).toHaveBeenCalledWith(15, expect.any(Uint8Array))
  })
})

// 免許証・社員番号で決まった人の照合: 置いた 1 回の指を撮ってから 1:N (`VEIN IDENTIFY KEEP`) で照合し、当たった ID が
// その人の枠のときだけ通す (VEIN VERIFY <id> は指定と違う ID に当たっても成功を返すため。2026-11-03 実測)
describe('matchVeinModuleEmployee', () => {
  const REC = new Uint8Array([0xDE, 0xED, 1])

  function keepPort(...hits: Array<number | null>) {
    const identifyKeep = vi.fn(async (_onAgain?: () => void) => ({ id: null as number | null, record: null as Uint8Array | null }))
    for (const h of hits) identifyKeep.mockResolvedValueOnce({ id: h, record: h === null ? null : REC })
    return { identify: vi.fn(async () => null as number | null), identifyKeep }
  }

  it('★ 当たった ID がその人の承認済みの枠なら、その ID と同じ置き方で撮った記録', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12), entry('emp-2', 13)])
    const p = keepPort(12)
    const onAgain = vi.fn()
    expect(await mod.matchVeinModuleEmployee(p, 'emp-1', onAgain)).toEqual({ id: 12, record: REC })
    expect(p.identifyKeep).toHaveBeenCalledTimes(1)
    expect(p.identifyKeep).toHaveBeenCalledWith(onAgain)
    expect(p.identify).not.toHaveBeenCalled()
  })

  it('★ 他人の枠に当たったら通さない (1 回やり直し、2 回とも他人・不一致なら null)。乗務員の ID は残さない', async () => {
    const { snapshotVeinLines } = await import('~/utils/vein-line-log')
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12), entry('emp-2', 13)])
    const onRetry = vi.fn()
    expect(await mod.matchVeinModuleEmployee(keepPort(13, null), 'emp-1', undefined, onRetry)).toBeNull()
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(snapshotVeinLines()).toContain('PC VEIN OTHER 13')
    expect(snapshotVeinLines()).not.toContain('emp-')
    // やり直しで本人に当たれば通す
    expect(await mod.matchVeinModuleEmployee(keepPort(13, 12), 'emp-1')).toEqual({ id: 12, record: REC })
  })

  it('承認待ちの枠・対応表に無い ID は本人にしない', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12, { approved: false })])
    expect(await mod.matchVeinModuleEmployee(keepPort(12, 12), 'emp-1')).toBeNull()
    expect(await mod.matchVeinModuleEmployee(keepPort(40, 40), 'emp-1')).toBeNull()
  })

  it('★ KEEP を知らない古いファームは、このページの間は普通の照合 (記録なし) に戻す。KEEP の口が無い port も同じ', async () => {
    const { snapshotVeinLines } = await import('~/utils/vein-line-log')
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12)])
    const p = keepPort()
    p.identifyKeep.mockRejectedValue(new Error(mod.VEIN_IDENTIFY_KEEP_UNSUPPORTED))
    p.identify.mockResolvedValue(12)
    expect(await mod.matchVeinModuleEmployee(p, 'emp-1')).toEqual({ id: 12, record: null })
    expect(snapshotVeinLines()).toContain('PC VEIN KEEP UNSUPPORTED')
    expect(await mod.matchVeinModuleEmployee(p, 'emp-1')).toEqual({ id: 12, record: null })
    expect(p.identifyKeep).toHaveBeenCalledTimes(1)
    expect(await mod.matchVeinModuleEmployee({ identify: vi.fn(async () => 12) }, 'emp-1')).toEqual({ id: 12, record: null })
  })

  it('読み取りの失敗は投げる', async () => {
    const p = keepPort()
    p.identifyKeep.mockRejectedValue(new Error('TIMEOUT'))
    await expect(mod.matchVeinModuleEmployee(p, 'emp-1')).rejects.toThrow('TIMEOUT')
  })
})

// 通ったら、同じ置き方で撮った 1 本で一番古い 1 本を入れ替え、その枠に書き戻す
describe('rotateVeinModuleRecord', () => {
  const REC = new Uint8Array([7, 7])
  const ROTATED = btoa(String.fromCharCode(0xDE, 0xED, 0x01))

  async function lines(): Promise<string[]> {
    const { snapshotVeinLines } = await import('~/utils/vein-line-log')
    return snapshotVeinLines().split('\n').filter(Boolean).map(l => l.replace(/^\S+ /, ''))
  }

  it('★ サーバーで入れ替えて預け、返った記録をその枠に書き戻し、対応表を新しい版 (この端末の記録) にする', async () => {
    localStorage.setItem('alc-vein-added-finger', 'native')
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12, { registeredDeviceId: 'dev-a', source: 'other' })])
    api.rotateVeinModuleDeviceRecord.mockResolvedValue({ employee_id: 'emp-1', record: ROTATED, updated_at: 'v9' })
    const p = port()
    await mod.rotateVeinModuleRecord(p, { id: 12, record: REC }, 'emp-1', 'manager-device')
    expect(api.rotateVeinModuleDeviceRecord).toHaveBeenCalledWith('emp-1', REC, 'own', 'manager-device')
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('emp-1')
    expect(p.syncWrite).toHaveBeenCalledWith(12, new Uint8Array([0xDE, 0xED, 0x01]))
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 'emp-1', moduleId: 12, updatedAt: 'v9', approved: true, registeredDeviceId: 'dev-a', source: 'own',
    }))
    expect(db.putVeinModuleEntry.mock.calls[0]![0].native).toBeUndefined()
    expect(await lines()).toEqual(['PC VEIN RECORD 12 KIND=rotated MODE=native'])
  })

  it('混ぜた記録の設定は pick を付けずに預ける。撮った記録が無ければ何もしない', async () => {
    localStorage.setItem('alc-vein-added-finger', 'mixed')
    api.rotateVeinModuleDeviceRecord.mockResolvedValue({ employee_id: 'emp-1', record: ROTATED, updated_at: 'v9' })
    await mod.rotateVeinModuleRecord(port(), { id: 12, record: REC }, 'emp-1')
    expect(api.rotateVeinModuleDeviceRecord).toHaveBeenCalledWith('emp-1', REC, undefined, 'default')
    const p = port()
    await mod.rotateVeinModuleRecord(p, { id: 12, record: null }, 'emp-1')
    expect(api.rotateVeinModuleDeviceRecord).toHaveBeenCalledTimes(1)
    expect(p.syncWrite).not.toHaveBeenCalled()
  })

  it('★ 預けられなければ枠も対応表もそのまま。書き戻しに失敗したら対応表から外す (次の用意が書き直す)。投げない', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12)])
    api.rotateVeinModuleDeviceRecord.mockRejectedValueOnce(new Error('409'))
    let p = port()
    await expect(mod.rotateVeinModuleRecord(p, { id: 12, record: REC }, 'emp-1')).resolves.toBeUndefined()
    expect(p.syncWrite).not.toHaveBeenCalled()
    expect(db.deleteVeinModuleEntry).not.toHaveBeenCalled()
    api.rotateVeinModuleDeviceRecord.mockResolvedValue({ employee_id: 'emp-1', record: ROTATED, updated_at: 'v9' })
    p = port()
    p.syncWrite.mockRejectedValueOnce(new Error('WRITE_SEQ'))
    await expect(mod.rotateVeinModuleRecord(p, { id: 12, record: REC }, 'emp-1')).resolves.toBeUndefined()
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('emp-1')
    expect(db.putVeinModuleEntry).not.toHaveBeenCalled()
    expect(await lines()).toEqual(['PC VEIN ROTATE 12 FAILED 409', 'PC VEIN ROTATE 12 FAILED WRITE_SEQ'])
  })
})

describe('用意のときの出どころ', () => {
  it('版が同じで書き直さなくても出どころを対応表に残す (その場で撮った記録はそのまま)', async () => {
    localStorage.setItem('alc-vein-added-finger', 'native')
    const B64 = btoa(String.fromCharCode(0xDE, 0xED))
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15)])
    api.getVeinModuleTemplate.mockResolvedValue({ employee_id: 'emp-1', record: B64, updated_at: 'v1', source: 'other' })
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBe(15)
    expect(db.putVeinModuleEntry).toHaveBeenLastCalledWith(expect.objectContaining({ employeeId: 'emp-1', source: 'other' }))
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15, { native: true })])
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBe(15)
    expect(db.putVeinModuleEntry.mock.calls.at(-1)![0]).not.toHaveProperty('source')
  })
})

// 認証ログ (Refs ippoan/alc-app-s3#352): 本番の判定はモジュールのまま。照合の後に裏で、撮影と状態をサーバーへ送る
describe('認証ログ (POST /api/vein/auth-shots)', () => {
  const SHOT = new Uint8Array([0xDE, 0xED, 9])

  function keep(id: number | null, record: Uint8Array | null = SHOT, extra: Record<string, unknown> = {}) {
    return {
      identify: vi.fn(async () => null as number | null),
      identifyKeep: vi.fn(async () => ({ id, record, score: 71, thresholds: [65, 60, 78], firmware: '1.2.3', ...extra })),
    }
  }

  async function lines(): Promise<string[]> {
    const { snapshotVeinLines } = await import('~/utils/vein-line-log')
    return snapshotVeinLines().split('\n').map(l => l.replace(/^\S+ /, ''))
  }

  beforeEach(async () => {
    // 前のテストが裏に回した送信が落ち着いてから始める
    await new Promise(r => setTimeout(r, 10))
    mod.resetVeinAuthLogEnabled()
    api.getVeinAuthLogEnabled.mockReset().mockResolvedValue({ enabled: true })
    api.postVeinAuthShot.mockReset().mockResolvedValue(undefined)
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 12), entry('emp-9', 13)])
  })

  it('★ 本人: body は employee_id・撮影・モジュールの結果 (slot・hit=self・点数・閾値)・ファームの版・captured_at。結果は変えない', async () => {
    expect(await mod.matchVeinModuleEmployee(keep(12), 'emp-1')).toEqual({ id: 12, record: SHOT })
    await vi.waitFor(() => expect(api.postVeinAuthShot).toHaveBeenCalledTimes(1))
    const [body, scope] = api.postVeinAuthShot.mock.calls[0]!
    expect(body).toMatchObject({
      employee_id: 'emp-1',
      shot: SHOT,
      module: { result: 'IDENTIFIED', slot: 12, hit: 'self', score: 71, thresholds: [65, 60, 78] },
      firmware: '1.2.3',
    })
    expect(Number.isNaN(Date.parse(body.captured_at))).toBe(false)
    expect(scope).toBe('default')
    await vi.waitFor(async () => expect((await lines()).some(l => /^PC VEIN AUTHLOG OK \d+$/.test(l))).toBe(true))
  })

  it('サーバーが返した位置のずれを AUTHLOG の行に付ける', async () => {
    api.postVeinAuthShot.mockResolvedValue({ entry: 7, dx: -6, dy: 3, overlap: 812, overlap0: 344 })
    await mod.matchVeinModuleEmployee(keep(12), 'emp-1')
    await vi.waitFor(async () => expect((await lines()).some(l => /^PC VEIN AUTHLOG OK \d+ SHIFT 7 -6 3 812 344$/.test(l))).toBe(true))
  })

  it('★ 他人の枠: hit=other、本番は不一致のまま。不一致: result=NOMATCH・slot=null・hit=none。点数・閾値・ファームが無ければ null', async () => {
    expect(await mod.matchVeinModuleEmployee(keep(13), 'emp-1', undefined, () => {}, 'manager-device')).toBeNull()
    await vi.waitFor(() => expect(api.postVeinAuthShot).toHaveBeenCalledTimes(2)) // 1 回やり直すので 2 回
    expect(api.postVeinAuthShot.mock.calls[0]![0].module).toMatchObject({ result: 'IDENTIFIED', slot: 13, hit: 'other' })
    expect(api.postVeinAuthShot.mock.calls[0]![1]).toBe('manager-device')

    api.postVeinAuthShot.mockClear()
    const miss = keep(null, SHOT, { score: undefined, thresholds: undefined, firmware: undefined })
    expect(await mod.matchVeinModuleEmployee(miss, 'emp-1', undefined, () => {})).toBeNull()
    await vi.waitFor(() => expect(api.postVeinAuthShot).toHaveBeenCalledTimes(2))
    const body = api.postVeinAuthShot.mock.calls[0]![0]
    expect(body.module).toEqual({ result: 'NOMATCH', slot: null, hit: 'none', score: null, thresholds: null })
    expect(body.firmware).toBeNull()
  })

  it('★ enabled=false (対象外のテナント) は送らない。問い合わせは 1 度だけ', async () => {
    api.getVeinAuthLogEnabled.mockResolvedValue({ enabled: false })
    await mod.matchVeinModuleEmployee(keep(12), 'emp-1')
    await mod.matchVeinModuleEmployee(keep(12), 'emp-1')
    await new Promise(r => setTimeout(r, 20))
    expect(api.getVeinAuthLogEnabled).toHaveBeenCalledTimes(1)
    expect(api.postVeinAuthShot).not.toHaveBeenCalled()
  })

  it('enabled の問い合わせが失敗したら false 扱い (送らない・投げない)', async () => {
    api.getVeinAuthLogEnabled.mockRejectedValue(new Error('network'))
    expect(await mod.matchVeinModuleEmployee(keep(12), 'emp-1')).toEqual({ id: 12, record: SHOT })
    await new Promise(r => setTimeout(r, 20))
    expect(api.postVeinAuthShot).not.toHaveBeenCalled()
  })

  it('撮った記録が無い (古いファーム) ときは送らない', async () => {
    expect(await mod.matchVeinModuleEmployee(keep(12, null), 'emp-1')).toEqual({ id: 12, record: null })
    await new Promise(r => setTimeout(r, 20))
    expect(api.getVeinAuthLogEnabled).not.toHaveBeenCalled()
    expect(api.postVeinAuthShot).not.toHaveBeenCalled()
  })

  it('★ 1:N (本人が決まっていない): 撮ってから照合し、承認済みの枠に当たった回を当たった人の撮影として送る (hit=self)', async () => {
    const port = keep(13)
    expect(await mod.identifyVeinModuleAnyone(port, undefined, () => {}, 'manager-device')).toBe(13)
    expect(port.identify).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(api.postVeinAuthShot).toHaveBeenCalledTimes(1))
    const [body, scope] = api.postVeinAuthShot.mock.calls[0]!
    expect(body).toMatchObject({ employee_id: 'emp-9', shot: SHOT, module: { result: 'IDENTIFIED', slot: 13, hit: 'self', score: 71 } })
    expect(scope).toBe('manager-device')
  })

  it('★ 1:N: 不一致は 1 回やり直して null・送らない (乗務員が決まらない)。対応表に無い・未承認の枠に当たっても送らない', async () => {
    const miss = keep(null)
    expect(await mod.identifyVeinModuleAnyone(miss)).toBeNull()
    expect(miss.identifyKeep).toHaveBeenCalledTimes(2)
    db.loadVeinModuleEntries.mockResolvedValue([{ ...entry('emp-1', 12), approved: false }])
    expect(await mod.identifyVeinModuleAnyone(keep(12))).toBe(12)
    expect(await mod.identifyVeinModuleAnyone(keep(14))).toBe(14)
    await new Promise(r => setTimeout(r, 20))
    expect(api.postVeinAuthShot).not.toHaveBeenCalled()
  })

  it('★ 1:N: 送らないテナントは今までどおりの照合 (撮らない)', async () => {
    api.getVeinAuthLogEnabled.mockResolvedValue({ enabled: false })
    const port = keep(12)
    port.identify.mockResolvedValue(12)
    expect(await mod.identifyVeinModuleAnyone(port)).toBe(12)
    expect(port.identifyKeep).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 20))
    expect(api.postVeinAuthShot).not.toHaveBeenCalled()
  })

  it('★ 送信が失敗しても投げず、照合の結果は変えない。診断ログに FAILED を 1 行 (生体データは載せない)', async () => {
    api.postVeinAuthShot.mockRejectedValue(new Error('API エラー (500)'))
    expect(await mod.matchVeinModuleEmployee(keep(12), 'emp-1')).toEqual({ id: 12, record: SHOT })
    await vi.waitFor(async () => expect((await lines()).some(l => l === 'PC VEIN AUTHLOG FAILED API エラー (500)')).toBe(true))
    expect((await lines()).join('\n')).not.toContain(btoa(String.fromCharCode(...SHOT)))
  })
})
