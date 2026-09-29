import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ApiEmployee } from '~/types'
import type { VeinTemplateSnapshot } from '~/utils/vein-db'

// キオスクの指静脈による本人確認 (Refs ippoan/vein-match#20)。
// オンラインはサーバー、オフライン (navigator.onLine === false / fetch のネットワーク失敗) は
// 手元の写しを wasm で照合する。照合そのものは vein-match.test.ts が見る

const api = vi.hoisted(() => ({
  identifyVein: vi.fn(),
  getEmployeeById: vi.fn(),
  getEmployees: vi.fn(),
  getVeinTemplates: vi.fn(),
}))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

const db = vi.hoisted(() => ({
  loadVeinTemplates: vi.fn(),
  saveVeinTemplates: vi.fn(),
}))
vi.mock('~/utils/vein-db', () => db)

const match = vi.hoisted(() => ({
  loadVeinWasm: vi.fn(),
  matchVeinOffline: vi.fn(),
}))
vi.mock('~/utils/vein-match', () => match)

let mod: typeof import('~/utils/vein-identify')

const EMP = { id: 'emp-1', name: '山田 太郎', face_approval_status: 'approved' } as ApiEmployee
const SNAPSHOT: VeinTemplateSnapshot = { logicVersion: '0.1.1', fetchedAt: 1, templates: [] }

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mod = await import('~/utils/vein-identify')
  setOnline(true)
  db.loadVeinTemplates.mockResolvedValue(SNAPSHOT)
  db.saveVeinTemplates.mockResolvedValue(undefined)
  match.loadVeinWasm.mockResolvedValue(undefined)
})

afterEach(() => {
  setOnline(true)
  vi.useRealTimers()
})

describe('identifyVeinEmployee — オンライン', () => {
  it('当たり: サーバーの employee_id で社員を引く', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: 'emp-1', name: '山田 太郎' })
    api.getEmployeeById.mockResolvedValue(EMP)
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'hit', employee: EMP })
    expect(api.identifyVein).toHaveBeenCalledWith('BDBD')
    expect(api.getEmployeeById).toHaveBeenCalledWith('emp-1')
    expect(match.matchVeinOffline).not.toHaveBeenCalled()
  })

  it('外れ: employee_id が null', async () => {
    api.identifyVein.mockResolvedValue({ employee_id: null })
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'miss' })
  })

  it('422: サーバーの message を理由に出す (オフラインへは回さない)', async () => {
    api.identifyVein.mockRejectedValue(new Error('API エラー (422): {"error":"unsupported_chara_format","message":"特徴量の形式が違います"}'))
    expect(await mod.identifyVeinEmployee('zz')).toEqual({ kind: 'error', message: '特徴量の形式が違います' })
    expect(match.matchVeinOffline).not.toHaveBeenCalled()
  })

  it('本文の読めない HTTP エラー: Error の文言をそのまま', async () => {
    api.identifyVein.mockRejectedValue(new Error('API エラー (502): Bad Gateway'))
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'error', message: 'API エラー (502): Bad Gateway' })
  })

  it('Error 以外が投げられても文字列にして返す', async () => {
    api.identifyVein.mockRejectedValue('weird')
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'error', message: 'weird' })
  })

  it('★ fetch がネットワークで失敗 (TypeError) したらオフラインの照合へ回す', async () => {
    api.identifyVein.mockRejectedValue(new TypeError('Failed to fetch'))
    match.matchVeinOffline.mockResolvedValue({ kind: 'hit', employeeId: 'emp-1' })
    api.getEmployees.mockResolvedValue([EMP])
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'hit', employee: EMP })
    expect(match.matchVeinOffline).toHaveBeenCalledWith('BDBD', SNAPSHOT)
  })
})

describe('identifyVeinEmployee — オフライン (navigator.onLine === false)', () => {
  beforeEach(() => setOnline(false))

  it('サーバーを叩かずに wasm で照合し、当たりは getEmployees() から引く', async () => {
    match.matchVeinOffline.mockResolvedValue({ kind: 'hit', employeeId: 'emp-1' })
    api.getEmployees.mockResolvedValue([{ ...EMP, id: 'emp-0' }, EMP])
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'hit', employee: EMP })
    expect(api.identifyVein).not.toHaveBeenCalled()
  })

  it('外れ', async () => {
    match.matchVeinOffline.mockResolvedValue({ kind: 'miss' })
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'miss' })
  })

  it('★ 版の不一致: 照合データが古いと出す', async () => {
    match.matchVeinOffline.mockResolvedValue({ kind: 'version_mismatch', stored: '0.1.0', wasm: '0.1.1' })
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'error', message: mod.VEIN_OFFLINE_STALE_MESSAGE })
  })

  it('一度も同期していない: 照合データが無いと出す', async () => {
    db.loadVeinTemplates.mockResolvedValue(null)
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'error', message: mod.VEIN_OFFLINE_NO_DATA_MESSAGE })
    expect(match.matchVeinOffline).not.toHaveBeenCalled()
  })

  it('形式エラー: code を理由に出す', async () => {
    match.matchVeinOffline.mockResolvedValue({ kind: 'invalid_chara', code: -22 })
    expect(await mod.identifyVeinEmployee('zz')).toEqual({ kind: 'error', message: '指静脈の読み取りデータの形式が正しくありません (-22)' })
  })

  it('当たったが社員一覧に居ない', async () => {
    match.matchVeinOffline.mockResolvedValue({ kind: 'hit', employeeId: 'emp-9' })
    api.getEmployees.mockResolvedValue([EMP])
    const r = await mod.identifyVeinEmployee('BDBD')
    expect(r).toMatchObject({ kind: 'error', message: expect.stringContaining('乗務員の情報が手元にありません') })
  })

  it('wasm が読めない等で投げたら理由を返す', async () => {
    match.matchVeinOffline.mockRejectedValue(new Error('wasm fetch failed'))
    expect(await mod.identifyVeinEmployee('BDBD')).toEqual({ kind: 'error', message: 'オフラインの指静脈照合に失敗しました: wasm fetch failed' })
  })
})

describe('syncVeinTemplates', () => {
  const RES = {
    logic_version: '0.1.1',
    templates: [{ employee_id: 'emp-1', template: 'AAAA', updated_at: '2026-09-25T00:00:00Z' }],
  }

  it('一覧を取って丸ごと保存し (logic_version も)、wasm を 1 度読んでおく', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(5000)
    api.getVeinTemplates.mockResolvedValue(RES)
    expect(await mod.syncVeinTemplates()).toBe(true)
    expect(db.saveVeinTemplates).toHaveBeenCalledWith({
      logicVersion: '0.1.1',
      fetchedAt: 5000,
      templates: [{ employeeId: 'emp-1', template: 'AAAA', updatedAt: '2026-09-25T00:00:00Z' }],
    })
    expect(match.loadVeinWasm).toHaveBeenCalledTimes(1)
  })

  it('失敗しても投げない (オフラインなら手元の写しで続ける)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.getVeinTemplates.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await mod.syncVeinTemplates()).toBe(false)
    expect(db.saveVeinTemplates).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ifOlderThanMs: 前回の同期から時間がたっていなければ取らない / たっていれば取る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    api.getVeinTemplates.mockResolvedValue(RES)
    vi.setSystemTime(0)
    await mod.syncVeinTemplates()
    vi.setSystemTime(mod.VEIN_TEMPLATE_SYNC_INTERVAL_MS - 1)
    expect(await mod.syncVeinTemplates({ ifOlderThanMs: mod.VEIN_TEMPLATE_SYNC_INTERVAL_MS })).toBe(false)
    vi.setSystemTime(mod.VEIN_TEMPLATE_SYNC_INTERVAL_MS)
    expect(await mod.syncVeinTemplates({ ifOlderThanMs: mod.VEIN_TEMPLATE_SYNC_INTERVAL_MS })).toBe(true)
    expect(api.getVeinTemplates).toHaveBeenCalledTimes(2)
  })

  it('ifOlderThanMs: 一度も同期していなければ取る', async () => {
    api.getVeinTemplates.mockResolvedValue(RES)
    expect(await mod.syncVeinTemplates({ ifOlderThanMs: mod.VEIN_TEMPLATE_SYNC_INTERVAL_MS })).toBe(true)
  })
})
