// 開発用の遠隔操作 (Refs ippoan/alc-app-s3#352): 設定・宛先の見分け・命令の実行
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'

const prep = vi.hoisted(() => ({ prepare: vi.fn(), identify: vi.fn() }))
vi.mock('~/utils/vein-module', () => ({
  prepareVeinModuleRecord: prep.prepare,
  identifyVeinModuleEmployee: prep.identify,
}))
const db = vi.hoisted(() => ({ load: vi.fn(), remove: vi.fn(async (_employeeId: string) => {}) }))
vi.mock('~/utils/vein-db', () => ({ loadVeinModuleEntries: db.load, deleteVeinModuleEntry: db.remove }))
const add = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('~/composables/useVeinAddDevice', () => ({ addThisDeviceFinger: add.fn }))
const lines = vi.hoisted(() => ({ snapshot: vi.fn(() => '') }))
vi.mock('~/utils/vein-line-log', () => ({
  redactVeinLine: (l: string) => l.replace(/[0-9A-F]{32,}/g, '<hex>'),
  snapshotVeinLines: lines.snapshot,
}))

import {
  KIOSK_REMOTE_KEY,
  kioskDeviceIdFromJwt,
  kioskDeviceIdFromSub,
  parseKioskCommand,
  readKioskRemoteEnabled,
  respondToKioskCommand,
  runKioskCommand,
  writeKioskRemoteEnabled,
  type KioskCommand,
  type KioskRemotePort,
} from '~/utils/kiosk-remote'
import type { VeinMatchResult } from '~/composables/useVeinSerial'

const EMP = '0f8fad5b-d9cb-469f-a165-70867728950e'

function jwt(payload: Record<string, unknown>): string {
  const seg = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${seg({ alg: 'HS256' })}.${seg(payload)}.sig`
}

function makePort(over: Partial<KioskRemotePort> = {}) {
  let fingerCb: (() => void) | null = null
  const lastMatch = ref<VeinMatchResult | null>(null)
  const port = {
    isConnected: ref(true),
    syncWrite: vi.fn(async () => {}),
    syncClear: vi.fn(async () => {}),
    say: vi.fn(async () => {}),
    enroll: vi.fn(async () => new Uint8Array()),
    verify: vi.fn(async () => true),
    identify: vi.fn(async () => 12),
    syncInfo: vi.fn(async () => ({ users: 1, max: 100 })),
    request: vi.fn(async () => 'VEIN RECORD 10 0 ' + 'AB'.repeat(20)),
    onFingerPlaced: vi.fn((cb: () => void) => {
      fingerCb = cb
      return () => { fingerCb = null }
    }),
    lastMatch,
    ...over,
  }
  return { port, place: () => fingerCb?.(), lastMatch }
}

function cmd(op: string, args: Record<string, unknown> = {}): KioskCommand {
  return { id: 'c1', device_id: 'alarm-k1', op, args }
}

/** 指を待つ命令: 案内 (say) の後に置く */
async function runWithFinger(c: KioskCommand, p: ReturnType<typeof makePort>, progress = vi.fn(async () => {})) {
  p.port.say.mockImplementation(async () => { queueMicrotask(p.place) })
  return runKioskCommand(c, { port: p.port, deviceId: 'alarm-k1', progress })
}

beforeEach(() => {
  localStorage.clear()
  prep.prepare.mockReset()
  prep.identify.mockReset()
  db.load.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('設定', () => {
  it('既定はオフ。書くと読める・消せる', () => {
    expect(readKioskRemoteEnabled()).toBe(false)
    writeKioskRemoteEnabled(true)
    expect(localStorage.getItem(KIOSK_REMOTE_KEY)).toBe('1')
    expect(readKioskRemoteEnabled()).toBe(true)
    writeKioskRemoteEnabled(false)
    expect(readKioskRemoteEnabled()).toBe(false)
  })

  it('localStorage が使えなければオフ (書きは黙る)', () => {
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(readKioskRemoteEnabled()).toBe(false)
    expect(() => writeKioskRemoteEnabled(true)).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })
})

describe('端末の id', () => {
  it('鍵で取った token は alarm-<指紋>、それ以外は sub のまま、無ければ null', () => {
    expect(kioskDeviceIdFromSub('alarm:0123456789abcdef')).toBe('alarm-0123456789abcdef')
    expect(kioskDeviceIdFromSub('k1')).toBe('k1')
    expect(kioskDeviceIdFromSub('')).toBeNull()
    expect(kioskDeviceIdFromSub(1)).toBeNull()
  })

  it('JWT の payload から作る。壊れた JWT は null', () => {
    expect(kioskDeviceIdFromJwt(jwt({ sub: 'alarm:0123456789abcdef' }))).toBe('alarm-0123456789abcdef')
    expect(kioskDeviceIdFromJwt(null)).toBeNull()
    expect(kioskDeviceIdFromJwt('nodot')).toBeNull()
    expect(kioskDeviceIdFromJwt('a.!!!.c')).toBeNull()
  })
})

describe('parseKioskCommand', () => {
  it('形の合う命令を読み、args が外れていれば {}', () => {
    expect(parseKioskCommand({ type: 'kiosk_command', id: 'c1', device_id: 'k', op: 'hello', args: { a: 1 } }))
      .toEqual({ id: 'c1', device_id: 'k', op: 'hello', args: { a: 1 } })
    expect(parseKioskCommand({ id: 'c1', device_id: 'k', op: 'hello', args: [1] })?.args).toEqual({})
  })

  it('id・宛先・op が外れていれば null', () => {
    expect(parseKioskCommand(null)).toBeNull()
    expect(parseKioskCommand('x')).toBeNull()
    expect(parseKioskCommand({ id: '', device_id: 'k', op: 'hello' })).toBeNull()
    expect(parseKioskCommand({ id: 'c', device_id: 1, op: 'hello' })).toBeNull()
    expect(parseKioskCommand({ id: 'c', device_id: 'k' })).toBeNull()
  })
})

describe('runKioskCommand', () => {
  it('hello / vein_info / vein_clear', async () => {
    const p = makePort()
    const deps = { port: p.port, deviceId: 'alarm-k1', progress: vi.fn(async () => {}) }
    expect(await runKioskCommand(cmd('hello'), deps)).toEqual({
      done: true, ok: true, op: 'hello', result: { device_id: 'alarm-k1', vein_connected: true },
    })
    expect((await runKioskCommand(cmd('vein_info'), deps)).result).toEqual({ users: 1, max: 100 })
    db.load.mockResolvedValue([
      { employeeId: EMP, moduleId: 10, updatedAt: 'v1', approved: true },
      { employeeId: 'e2', moduleId: 11, updatedAt: 'v1', approved: true },
    ])
    expect((await runKioskCommand(cmd('vein_clear', { id: 10 }), deps)).result).toEqual({ cleared: 10, module: 'cleared', entries_removed: 1 })
    expect(p.port.syncClear).toHaveBeenCalledWith(10)
    // 対応表のその ID の行も消す (ほかの ID の行は残す)
    expect(db.remove).toHaveBeenCalledTimes(1)
    expect(db.remove).toHaveBeenCalledWith(EMP)
    // モジュールが既に空 (未登録) でも、対応表の行は消す
    p.port.syncClear.mockRejectedValueOnce(new Error('RC=07'))
    expect((await runKioskCommand(cmd('vein_clear', { id: 10 }), deps)).result).toEqual({ cleared: 10, module: 'RC=07', entries_removed: 1 })
    expect(db.remove).toHaveBeenCalledTimes(2)
    expect(await runKioskCommand(cmd('vein_clear', { id: 9 }), deps)).toMatchObject({ ok: false, error: 'id は 10〜100 で指定してください' })
  })

  it('vein_entries は対応表だけ (記録の中身は無い)', async () => {
    db.load.mockResolvedValue([
      { employeeId: EMP, moduleId: 10, updatedAt: 'v1', approved: true, native: true, registeredDeviceId: 'alarm:x', lastUsedAt: 5, source: 'other' },
      { employeeId: 'e2', moduleId: 11, updatedAt: 'v2', approved: false },
    ])
    const r = await runKioskCommand(cmd('vein_entries'), { port: makePort().port, deviceId: 'k', progress: vi.fn() })
    expect(r.result).toEqual([
      { employee_id: EMP, module_id: 10, version: 'v1', approved: true, native: true, registered_device_id: 'alarm:x', last_used_at: 5, source: 'other' },
      { employee_id: 'e2', module_id: 11, version: 'v2', approved: false, native: false, registered_device_id: null, last_used_at: null, source: null },
    ])
  })

  it('vein_prepare はキオスクと同じ手順を呼ぶ (scope は既定でキオスクの鍵)', async () => {
    prep.prepare.mockResolvedValue(10)
    const p = makePort()
    const r = await runKioskCommand(cmd('vein_prepare', { employee_id: EMP }), { port: p.port, deviceId: 'k', progress: vi.fn() })
    expect(r.result).toEqual({ module_id: 10 })
    expect(prep.prepare).toHaveBeenCalledWith(p.port, EMP, 'default')
    expect(await runKioskCommand(cmd('vein_prepare', { employee_id: 'x' }), { port: p.port, deviceId: 'k', progress: vi.fn() }))
      .toMatchObject({ ok: false, error: 'employee_id (UUID) が要ります' })
  })

  it('vein_verify は指を待ってから 1:1 (点数も返す)、id が無ければ 1:N', async () => {
    const p = makePort()
    p.lastMatch.value = { kind: 'VERIFIED', id: 10, score: 73, threshold: 55, via: 'FV', thresholds: [62, 55, 79] }
    const progress = vi.fn(async () => {})
    const r = await runWithFinger(cmd('vein_verify', { id: 10 }), p, progress)
    expect(progress).toHaveBeenCalledWith({ done: false, stage: 'waiting_finger' })
    expect(p.port.say).toHaveBeenCalledWith('PLACE')
    expect(p.port.verify).toHaveBeenCalledWith(10)
    expect(r.result).toEqual({ module_id: 10, match: { kind: 'VERIFIED', id: 10, score: 73, threshold: 55, via: 'FV', thresholds: [62, 55, 79] } })

    p.port.verify.mockResolvedValueOnce(false)
    p.lastMatch.value = null
    expect((await runWithFinger(cmd('vein_verify', { id: 10 }), p)).result).toEqual({ module_id: null, match: null })
    expect((await runWithFinger(cmd('vein_verify'), p)).result).toMatchObject({ module_id: 12 })
    expect(p.port.identify).toHaveBeenCalled()
  })

  it('指が置かれなければ finger_timeout (案内の失敗と途中経過の失敗は無視)', async () => {
    vi.useFakeTimers()
    const p = makePort({ say: vi.fn(async () => { throw new Error('busy') }) })
    const pending = runKioskCommand(cmd('vein_verify', { id: 10, wait_finger_ms: 1000 }), {
      port: p.port, deviceId: 'k', progress: vi.fn(async () => { throw new Error('net') }),
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ ok: false, error: 'finger_timeout' })
    expect(p.port.verify).not.toHaveBeenCalled()
  })

  it('kiosk_flow: 用意 → 指 → 1:1 → 乗務員の照会 (本人か)', async () => {
    prep.prepare.mockResolvedValue(10)
    prep.identify.mockResolvedValue({ kind: 'hit', employee: { id: EMP } })
    const p = makePort()
    const r = await runWithFinger(cmd('kiosk_flow', { employee_id: EMP }), p)
    expect(r.result).toEqual({ module_id: 10, verified: true, match: null, outcome: 'hit', expected: true })
    expect(prep.identify).toHaveBeenCalledWith(10, 'default')
  })

  it('kiosk_flow: 不一致は照会しない・承認済みの記録が無ければ指を待たない', async () => {
    prep.prepare.mockResolvedValue(10)
    const p = makePort({ verify: vi.fn(async () => false) })
    expect((await runWithFinger(cmd('kiosk_flow', { employee_id: EMP }), p)).result)
      .toEqual({ module_id: 10, verified: false, match: null, outcome: 'miss' })
    expect(prep.identify).not.toHaveBeenCalled()

    prep.prepare.mockResolvedValue(null)
    const q = makePort()
    expect((await runKioskCommand(cmd('kiosk_flow', { employee_id: EMP }), { port: q.port, deviceId: 'k', progress: vi.fn() })).result)
      .toEqual({ module_id: null, reason: 'no_approved_record' })
    expect(q.port.onFingerPlaced).not.toHaveBeenCalled()
  })

  it('serial は応答を伏せて返す。line と prefix が要る', async () => {
    const p = makePort()
    const deps = { port: p.port, deviceId: 'k', progress: vi.fn() }
    expect((await runKioskCommand(cmd('serial', { line: 'VEIN TEST READ 10', prefix: 'VEIN RECORD' }), deps)).result)
      .toEqual({ line: 'VEIN RECORD 10 0 <hex>' })
    expect(p.port.request).toHaveBeenCalledWith('VEIN TEST READ 10', 'VEIN RECORD', 10_000)
    await runKioskCommand(cmd('serial', { line: 'X', prefix: 'Y', timeout_ms: 999_999 }), deps)
    expect(p.port.request).toHaveBeenLastCalledWith('X', 'Y', 100_000)
    expect(await runKioskCommand(cmd('serial', { line: 'X' }), deps)).toMatchObject({ ok: false, error: 'line と prefix が要ります' })
  })

  it('lines は直近 n 行 (既定 50)', async () => {
    lines.snapshot.mockReturnValue(Array.from({ length: 60 }, (_, i) => `L${i}`).join('\n'))
    const deps = { port: makePort().port, deviceId: 'k', progress: vi.fn() }
    expect(((await runKioskCommand(cmd('lines', { n: 2 }), deps)).result as { lines: string[] }).lines).toEqual(['L58', 'L59'])
    expect(((await runKioskCommand(cmd('lines'), deps)).result as { lines: string[] }).lines).toHaveLength(50)
  })

  it('firmware_update は途中経過を返してから更新し、結果を返す。渡されていない画面では断る', async () => {
    const firmwareUpdate = vi.fn(async () => 'updated')
    const progress = vi.fn(async () => {})
    const r = await runKioskCommand(cmd('firmware_update'), { port: makePort().port, deviceId: 'k', progress, firmwareUpdate })
    expect(progress).toHaveBeenCalledWith({ done: false, stage: 'updating' })
    expect(r).toEqual({ done: true, ok: true, op: 'firmware_update', result: { outcome: 'updated' } })
    const failingProgress = vi.fn(async () => { throw new Error('net') })
    expect((await runKioskCommand(cmd('firmware_update'), { port: makePort().port, deviceId: 'k', progress: failingProgress, firmwareUpdate })).result)
      .toEqual({ outcome: 'updated' })
    expect(await runKioskCommand(cmd('firmware_update'), { port: makePort().port, deviceId: 'k', progress }))
      .toMatchObject({ ok: false, error: 'この画面ではファームを更新できません' })
  })

  it('log_upload は理由 on_demand で上げて結果を返す。渡されていない画面では断る', async () => {
    const logUpload = vi.fn(async () => true)
    const deps = { port: makePort().port, deviceId: 'k', progress: vi.fn(), logUpload }
    expect(await runKioskCommand(cmd('log_upload'), deps))
      .toEqual({ done: true, ok: true, op: 'log_upload', result: { uploaded: true } })
    expect(logUpload).toHaveBeenCalledWith('on_demand')
    logUpload.mockResolvedValueOnce(false)
    expect((await runKioskCommand(cmd('log_upload'), deps)).result).toEqual({ uploaded: false })
    expect(await runKioskCommand(cmd('log_upload'), { port: makePort().port, deviceId: 'k', progress: vi.fn() }))
      .toMatchObject({ ok: false, error: 'この画面ではログを上げられません' })
  })

  it('vein_add_finger は「この端末の指を足す」と同じ手順を呼び、置き直しを途中経過で返す。失敗は FAILED を鳴らして ok: false', async () => {
    const p = makePort()
    const progress = vi.fn(async () => {})
    add.fn.mockReset().mockImplementation(async (_port, _emp, _scope, onPlace: (n: number, total?: number) => void) => {
      onPlace(2, 6)
    })
    expect(await runKioskCommand(cmd('vein_add_finger', { employee_id: EMP }), { port: p.port, deviceId: 'k', progress, scope: 'manager-device' }))
      .toEqual({ done: true, ok: true, op: 'vein_add_finger', result: { added: true } })
    expect(add.fn).toHaveBeenCalledWith(p.port, EMP, 'manager-device', expect.any(Function))
    expect(progress).toHaveBeenCalledWith({ done: false, stage: 'waiting_finger' })
    expect(progress).toHaveBeenCalledWith({ done: false, stage: 'place_again', n: 2, total: 6 })
    expect(p.port.say).toHaveBeenLastCalledWith('ENROLLED')
    add.fn.mockRejectedValueOnce(new Error('RETAKE'))
    expect(await runKioskCommand(cmd('vein_add_finger', { employee_id: EMP }), { port: p.port, deviceId: 'k', progress: vi.fn(async () => { throw new Error('net') }) }))
      .toMatchObject({ ok: false, error: 'RETAKE' })
    expect(p.port.say).toHaveBeenLastCalledWith('FAILED')
    expect(await runKioskCommand(cmd('vein_add_finger'), { port: p.port, deviceId: 'k', progress }))
      .toMatchObject({ ok: false, error: 'employee_id (UUID) が要ります' })
  })

  it('知らない op は ok: false', async () => {
    expect(await runKioskCommand(cmd('nope'), { port: makePort().port, deviceId: 'k', progress: vi.fn() }))
      .toEqual({ done: true, ok: false, op: 'nope', error: '知らない op です: nope' })
  })
})

describe('respondToKioskCommand', () => {
  const SEAT_JWT = jwt({ sub: 'alarm:0123456789abcdef', dev_device: true })
  const frame = (deviceId: string, op = 'hello') => ({ type: 'kiosk_command', id: 'c1', device_id: deviceId, op, args: {} })
  const deps = (over: Partial<Parameters<typeof respondToKioskCommand>[1]> = {}) => ({
    jwt: vi.fn(async (): Promise<string | null> => SEAT_JWT),
    port: makePort().port,
    scope: 'manager-device' as const,
    report: vi.fn(async () => {}),
    ...over,
  })

  it('★ オンなら自分宛て・全キオスク宛ての命令に、渡された鍵の scope で答える', async () => {
    writeKioskRemoteEnabled(true)
    prep.prepare.mockResolvedValue(10)
    const d = deps()
    await respondToKioskCommand(frame('alarm-0123456789abcdef'), d)
    await respondToKioskCommand({ ...frame('*', 'vein_prepare'), args: { employee_id: EMP } }, d)
    expect(d.report.mock.calls).toEqual([
      ['c1', { done: true, ok: true, op: 'hello', result: { device_id: 'alarm-0123456789abcdef', vein_connected: true } }],
      ['c1', { done: true, ok: true, op: 'vein_prepare', result: { module_id: 10 } }],
    ])
    expect(prep.prepare).toHaveBeenCalledWith(d.port, EMP, 'manager-device')
  })

  it('オフ・他の端末宛て・形が外れた命令・token が無いときは答えない', async () => {
    const d = deps()
    await respondToKioskCommand(frame('*'), d)
    writeKioskRemoteEnabled(true)
    await respondToKioskCommand(frame('alarm-ffffffffffffffff'), d)
    await respondToKioskCommand({ type: 'kiosk_command' }, d)
    await respondToKioskCommand(frame('*'), deps({ jwt: vi.fn(async () => null), report: d.report }))
    await respondToKioskCommand(frame('*'), deps({ jwt: vi.fn(async () => { throw new Error('no key') }), report: d.report }))
    expect(d.report).not.toHaveBeenCalled()
  })

  it('★ 開発用の鍵でない端末 (本番) は、設定がオンでも答えない', async () => {
    writeKioskRemoteEnabled(true)
    const d = deps()
    for (const payload of [{ sub: 'alarm:0123456789abcdef' }, { sub: 'alarm:0123456789abcdef', dev_device: false }]) {
      await respondToKioskCommand(frame('*'), deps({ jwt: vi.fn(async () => jwt(payload)), report: d.report }))
    }
    expect(d.report).not.toHaveBeenCalled()
    await respondToKioskCommand(frame('*'), d)
    expect(d.report).toHaveBeenCalledTimes(1)
  })

  it('ファームの更新の口を runKioskCommand へ渡す', async () => {
    writeKioskRemoteEnabled(true)
    const firmwareUpdate = vi.fn(async () => 'up_to_date')
    const d = deps({ firmwareUpdate })
    await respondToKioskCommand(frame('*', 'firmware_update'), d)
    expect(d.report).toHaveBeenLastCalledWith('c1', { done: true, ok: true, op: 'firmware_update', result: { outcome: 'up_to_date' } })
  })

  it('ログを上げる口を runKioskCommand へ渡す', async () => {
    writeKioskRemoteEnabled(true)
    const logUpload = vi.fn(async () => true)
    const d = deps({ logUpload })
    await respondToKioskCommand(frame('*', 'log_upload'), d)
    expect(d.report).toHaveBeenLastCalledWith('c1', { done: true, ok: true, op: 'log_upload', result: { uploaded: true } })
  })

  it('返事の失敗は握る', async () => {
    writeKioskRemoteEnabled(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(respondToKioskCommand(frame('*'), deps({ report: vi.fn(async () => { throw new Error('net') }) }))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
