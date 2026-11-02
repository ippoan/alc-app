/**
 * 開発用の遠隔操作 (Refs ippoan/alc-app-s3#352)。auth-worker の MCP の tool (`kiosk_command`) から、
 * このキオスクがつかんでいる Vein Station を、本物の画面と同じ道具 (端末の鍵・対応表・同期) のまま操る。
 *
 * 経路: MCP → recorder `POST /kiosk-command` → 購読 WS に `kiosk_command` → **ここ** →
 *   `POST /api/kiosk-remote/result` (端末の token) → recorder の `cmdres:<id>` → MCP が取る
 *
 * ★ **端末設定でオンにしたキオスクだけ**が実行する (既定はオフ。開発に使う PC だけオンにする)
 * ★ 宛先 (`device_id`) が自分でない命令は実行しない (`*` は全キオスク)。購読の合図は全キオスクに届くため
 * ★ 指静脈の記録の中身 (16 進) は返さない。シリアルの行は `redactVeinLine` で伏せてから返す
 */
import type { DeepReadonly, Ref } from 'vue'
import type { RequestTokenScope } from '~/utils/api'
import { identifyVeinModuleEmployee, prepareVeinModuleRecord } from '~/utils/vein-module'
import type { VeinModulePort } from '~/utils/vein-module'
import { loadVeinModuleEntries } from '~/utils/vein-db'
import { redactVeinLine, snapshotVeinLines } from '~/utils/vein-line-log'
import type { VeinMatchResult } from '~/composables/useVeinSerial'

/** 端末設定の key (localStorage)。`'1'` でオン */
export const KIOSK_REMOTE_KEY = 'alc-kiosk-remote'

/** 指静脈の端末 (Vein Station / Vein Base) のファームの更新の target (機体の FLAVOR で中身を引き分ける) */
export const VEIN_FIRMWARE_TARGET = 'timecard-station'

/** 指が置かれるのを待つ既定の時間 (人が端末の前に来るまで) */
export const KIOSK_REMOTE_FINGER_WAIT_MS = 60_000
/** 指を待てる上限 (MCP 側の待ちより短く) */
const FINGER_WAIT_MAX_MS = 100_000

export function readKioskRemoteEnabled(): boolean {
  try {
    return localStorage.getItem(KIOSK_REMOTE_KEY) === '1'
  }
  catch {
    return false
  }
}

export function writeKioskRemoteEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KIOSK_REMOTE_KEY, '1')
    else localStorage.removeItem(KIOSK_REMOTE_KEY)
  }
  catch {
    // 保存できない環境 (プライベートウィンドウ等) はオフのまま
  }
}

/**
 * 端末の token の `sub` から recorder の端末の id を作る (server/api/vein-fleet/report.post.ts と同じ決め方):
 * 鍵で取った token (`alarm:<16 hex>`) は `alarm-<16 hex>`、それ以外は `sub` のまま
 */
export function kioskDeviceIdFromSub(sub: unknown): string | null {
  if (typeof sub !== 'string' || !sub) return null
  const m = /^alarm:([0-9a-f]{16})$/.exec(sub)
  return m ? `alarm-${m[1]}` : sub
}

/** JWT の payload の `sub` から端末の id を作る (署名は確かめない。宛先の見分けにだけ使う) */
export function kioskDeviceIdFromJwt(jwt: string | null | undefined): string | null {
  const part = jwt?.split('.')[1]
  if (!part) return null
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return kioskDeviceIdFromSub((JSON.parse(json) as { sub?: unknown }).sub)
  }
  catch {
    return null
  }
}

export interface KioskCommand {
  id: string
  device_id: string
  op: string
  args: Record<string, unknown>
}

/** 購読 WS の `kiosk_command` を読む。形が外れていれば null */
export function parseKioskCommand(data: unknown): KioskCommand | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id || typeof d.device_id !== 'string' || typeof d.op !== 'string') return null
  const args = d.args && typeof d.args === 'object' && !Array.isArray(d.args) ? d.args as Record<string, unknown> : {}
  return { id: d.id, device_id: d.device_id, op: d.op, args }
}

/** 遠隔操作に使う Vein Station の口 (`useVeinSerial` の一部) */
export interface KioskRemotePort extends VeinModulePort {
  say: (x: 'PLACE') => Promise<void>
  verify: (id: number) => Promise<boolean>
  identify: () => Promise<number | null>
  syncInfo: () => Promise<{ users: number, max: number }>
  request: (line: string, matchPrefix: string, timeoutMs: number) => Promise<string>
  onFingerPlaced: (cb: () => void) => () => void
  lastMatch: Readonly<Ref<DeepReadonly<VeinMatchResult> | null>>
}

export interface KioskRemoteDeps {
  port: KioskRemotePort
  deviceId: string
  /** 途中経過を返す (指を待っている等)。失敗は無視してよい */
  progress: (payload: Record<string, unknown>) => Promise<void>
  /** 照合データと当たった人の照会に使う鍵 */
  scope?: RequestTokenScope
  /**
   * 指静脈の端末のファームを最新にする (`useSerialOta().run('timecard-station')`、画面の更新と同じ手順)。
   * 渡さない画面では `firmware_update` を断る
   */
  firmwareUpdate?: () => Promise<string>
}

function moduleId(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 10 || n > 100) throw new Error('id は 10〜100 で指定してください')
  return n
}

function employeeId(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v)) throw new Error('employee_id (UUID) が要ります')
  return v
}

/** 指が置かれるまで待つ (`VEIN SAY PLACE` で案内してから)。時間切れは Error('finger_timeout') */
async function waitFinger(deps: KioskRemoteDeps, ms: unknown): Promise<void> {
  const limit = Math.min(Number(ms) > 0 ? Number(ms) : KIOSK_REMOTE_FINGER_WAIT_MS, FINGER_WAIT_MAX_MS)
  await deps.progress({ done: false, stage: 'waiting_finger' }).catch(() => {})
  let off: (() => void) | undefined
  const placed = new Promise<void>((resolve) => {
    off = deps.port.onFingerPlaced(resolve)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('finger_timeout')), limit)
  })
  try {
    await deps.port.say('PLACE').catch(() => {})
    await Promise.race([placed, timeout])
  }
  finally {
    off?.()
    clearTimeout(timer)
  }
}

/** 照合の結果 (点数まで)。モジュールが返した最後の結果 */
function matchOf(port: KioskRemotePort): Record<string, unknown> | null {
  const m = port.lastMatch.value
  return m ? { ...m } : null
}

/**
 * 命令を 1 つ実行して返事の中身を返す (`done: true`)。失敗は `ok: false` と理由。投げない
 *
 * | op | args | 中身 |
 * |---|---|---|
 * | `hello` | | 端末の id・Vein Station がつながっているか |
 * | `vein_info` | | モジュールの登録人数と上限 |
 * | `vein_entries` | | 対応表 (誰をどの ID に置いたか。記録の中身は無い) |
 * | `vein_clear` | `id` | モジュールの ID の登録を消す (対応表は触らない) |
 * | `vein_prepare` | `employee_id` | キオスクと同じ手順でその人の記録をモジュールに用意する |
 * | `vein_verify` | `id?`, `wait_finger_ms?` | 指を待って照合 (id で 1:1、無ければ 1:N) |
 * | `kiosk_flow` | `employee_id`, `wait_finger_ms?` | 免許証で決まった後のキオスクの照合 (用意 → 指 → 1:1 → 乗務員の照会) |
 * | `serial` | `line`, `prefix`, `timeout_ms?` | 1 行送って応答 1 行 (伏せて返す) |
 * | `lines` | `n?` | 直近のシリアルの行 (伏せた写し) |
 * | `firmware_update` | | 指静脈の端末のファームを最新にする (数分かかる。書き終えると画面を読み込み直す) |
 */
export async function runKioskCommand(cmd: KioskCommand, deps: KioskRemoteDeps): Promise<Record<string, unknown>> {
  const { port, scope = 'default' } = deps
  const a = cmd.args
  try {
    let result: unknown
    switch (cmd.op) {
      case 'hello':
        result = { device_id: deps.deviceId, vein_connected: port.isConnected.value }
        break
      case 'vein_info':
        result = await port.syncInfo()
        break
      case 'vein_entries':
        result = (await loadVeinModuleEntries()).map(e => ({
          employee_id: e.employeeId,
          module_id: e.moduleId,
          version: e.updatedAt,
          approved: e.approved,
          native: e.native ?? false,
          registered_device_id: e.registeredDeviceId ?? null,
          last_used_at: e.lastUsedAt ?? null,
        }))
        break
      case 'vein_clear': {
        const id = moduleId(a.id)
        await port.syncClear(id)
        result = { cleared: id }
        break
      }
      case 'vein_prepare':
        result = { module_id: await prepareVeinModuleRecord(port, employeeId(a.employee_id), scope) }
        break
      case 'vein_verify': {
        const id = a.id === undefined || a.id === 0 ? null : moduleId(a.id)
        await waitFinger(deps, a.wait_finger_ms)
        const hit = id === null ? await port.identify() : (await port.verify(id) ? id : null)
        result = { module_id: hit, match: matchOf(port) }
        break
      }
      case 'kiosk_flow': {
        const emp = employeeId(a.employee_id)
        const id = await prepareVeinModuleRecord(port, emp, scope)
        if (id === null) {
          result = { module_id: null, reason: 'no_approved_record' }
          break
        }
        await waitFinger(deps, a.wait_finger_ms)
        const verified = await port.verify(id)
        const outcome = verified ? await identifyVeinModuleEmployee(id, scope) : { kind: 'miss' as const }
        result = {
          module_id: id,
          verified,
          match: matchOf(port),
          outcome: outcome.kind,
          ...(outcome.kind === 'hit' ? { expected: outcome.employee.id === emp } : {}),
        }
        break
      }
      case 'serial': {
        if (typeof a.line !== 'string' || typeof a.prefix !== 'string') throw new Error('line と prefix が要ります')
        const timeout = Math.min(Number(a.timeout_ms) > 0 ? Number(a.timeout_ms) : 10_000, FINGER_WAIT_MAX_MS)
        result = { line: redactVeinLine(await port.request(a.line, a.prefix, timeout)) }
        break
      }
      case 'lines': {
        const n = Math.min(Number(a.n) > 0 ? Number(a.n) : 50, 500)
        result = { lines: snapshotVeinLines().split('\n').filter(Boolean).slice(-n) }
        break
      }
      case 'firmware_update': {
        if (!deps.firmwareUpdate) throw new Error('この画面ではファームを更新できません')
        await deps.progress({ done: false, stage: 'updating' }).catch(() => {})
        result = { outcome: await deps.firmwareUpdate() }
        break
      }
      default:
        throw new Error(`知らない op です: ${cmd.op}`)
    }
    return { done: true, ok: true, op: cmd.op, result }
  }
  catch (e) {
    return { done: true, ok: false, op: cmd.op, error: (e as Error).message }
  }
}

/**
 * 購読 WS で受けた `kiosk_command` に答える (キオスクの VeinFleetHost と運行管理者席の ManagerSeatRemoteHost で共通)。
 * 端末設定がオフ・形が外れた命令・自分宛てでない命令・端末の token が無いときは何もしない。返事の失敗は握る
 */
export async function respondToKioskCommand(data: unknown, deps: {
  /** この端末の token (宛先の見分けに使う) */
  jwt: () => Promise<string | null>
  port: KioskRemotePort
  /** 照合データと当たった人の照会に使う鍵 */
  scope: RequestTokenScope
  /** 返事を送る (途中経過も同じ口) */
  report: (id: string, payload: Record<string, unknown>) => Promise<void>
  /** 指静脈の端末のファームを最新にする ({@link KioskRemoteDeps.firmwareUpdate}) */
  firmwareUpdate?: () => Promise<string>
}): Promise<void> {
  const cmd = parseKioskCommand(data)
  if (!cmd || !readKioskRemoteEnabled()) return
  const deviceId = kioskDeviceIdFromJwt(await deps.jwt().catch(() => null))
  if (!deviceId || (cmd.device_id !== '*' && cmd.device_id !== deviceId)) return
  const send = (payload: Record<string, unknown>) => deps.report(cmd.id, payload)
  try {
    await send(await runKioskCommand(cmd, {
      port: deps.port,
      deviceId,
      progress: send,
      scope: deps.scope,
      firmwareUpdate: deps.firmwareUpdate,
    }))
  }
  catch (e) {
    console.warn('[kiosk-remote] 返事を送れませんでした:', e)
  }
}
