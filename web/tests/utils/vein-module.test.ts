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
  getVeinModuleTemplates: vi.fn(),
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
  vi.clearAllMocks()
  vi.resetModules()
  mod = await import('~/utils/vein-module')
  db.loadVeinModuleEntries.mockResolvedValue([])
  db.putVeinModuleEntry.mockResolvedValue(undefined)
  db.deleteVeinModuleEntry.mockResolvedValue(undefined)
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

describe('prepareVeinModuleRecord', () => {
  const B64 = btoa(String.fromCharCode(0xDE, 0xED))

  it('手元の対応表と版が同じなら、書かずにその ID', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15)])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [{ employee_id: 'emp-1', record: B64, updated_at: 'v1' }] })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(15)
    expect(p.syncWrite).not.toHaveBeenCalled()
  })

  it('★ 端末に無ければ DB の記録を空きへ書き、対応表に承認済みで入れる', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('other', 10)])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [{ employee_id: 'emp-1', record: B64, updated_at: 'v3' }] })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(11)
    expect(p.syncWrite).toHaveBeenCalledWith(11, expect.any(Uint8Array))
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith({ employeeId: 'emp-1', moduleId: 11, updatedAt: 'v3', approved: true, registeredDeviceId: null })
  })

  it('登録した端末をサーバーの値で対応表に入れる', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([])
    api.getVeinModuleTemplates.mockResolvedValue({
      templates: [{ employee_id: 'emp-1', record: B64, updated_at: 'v3', registered_device_id: 'alarm:0123456789abcdef' }],
    })
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBe(10)
    expect(db.putVeinModuleEntry).toHaveBeenCalledWith(expect.objectContaining({ registeredDeviceId: 'alarm:0123456789abcdef' }))
  })

  it('版が違えば (承認待ちで置いてあった場合も) 同じ ID に書き直す。古い対応は先に外す', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 20, { approved: false })])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [{ employee_id: 'emp-1', record: B64, updated_at: 'v2' }] })
    const p = port()
    expect(await mod.prepareVeinModuleRecord(p, 'emp-1')).toBe(20)
    expect(db.deleteVeinModuleEntry).toHaveBeenCalledWith('emp-1')
    expect(p.syncWrite).toHaveBeenCalledWith(20, expect.any(Uint8Array))
  })

  it('DB に承認済みの記録が無ければ null', async () => {
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBeNull()
  })

  it('サーバーに届かなければ、手元の承認済みの ID を使う (無い・承認待ちなら null)', async () => {
    api.getVeinModuleTemplates.mockRejectedValue(new TypeError('Failed to fetch'))
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15)])
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBe(15)
    db.loadVeinModuleEntries.mockResolvedValue([entry('emp-1', 15, { approved: false })])
    expect(await mod.prepareVeinModuleRecord(port(), 'emp-1')).toBeNull()
  })

  it('ほかの失敗・ID の空き無し・書き込みの失敗は投げる', async () => {
    api.getVeinModuleTemplates.mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(mod.prepareVeinModuleRecord(port(), 'emp-1')).rejects.toThrow('HTTP 500')
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [{ employee_id: 'emp-1', record: B64, updated_at: 'v1' }] })
    db.loadVeinModuleEntries.mockResolvedValue(Array.from({ length: 91 }, (_, i) => entry(`x${i}`, 10 + i)))
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

  it('つながっていないときは何もしない', async () => {
    expect(await mod.syncVeinModule(port(false))).toBe(false)
    expect(api.getVeinModuleTemplates).not.toHaveBeenCalled()
  })

  it('鍵の種類を渡すと、その鍵で承認済みの一覧を取る', async () => {
    db.loadVeinModuleEntries.mockResolvedValue([])
    api.getVeinModuleTemplates.mockResolvedValue({ templates: [] })
    expect(await mod.syncVeinModule(port(), { scope: 'manager-device' })).toBe(true)
    expect(api.getVeinModuleTemplates).toHaveBeenLastCalledWith('manager-device')
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
    expect(api.getVeinModuleTemplates).toHaveBeenLastCalledWith(undefined)

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
      [entry('changed', 12, { updatedAt: 'v2', registeredDeviceId: null })],
      [entry('new', 13, { registeredDeviceId: null })],
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
      [entry('new', 12, { registeredDeviceId: 'kiosk-2' })],
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
    expect(db.putVeinModuleEntry.mock.calls).toEqual([[entry('new', 10, { registeredDeviceId: null })]])
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
    expect(await mod.syncVeinModule(p)).toBe(true)
    expect(p.syncWrite).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[vein] モジュールの ID が空いていません (10〜100)')
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
