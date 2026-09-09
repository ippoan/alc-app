/**
 * 据置警告デバイス (Atom VoiceS3R / USB CDC) との接続と heartbeat 送信。
 *
 * つなぐ先は**運行管理者の PC**。見張る対象は「運行管理者ダッシュボードが開いていて、
 * 乗務員からの着信を受けられる状態か」であって、乗務員側キオスクの生死ではない。
 *
 * ブラウザは「鳴れ」と命令しない。3 秒ごとに状態を 1 行送るだけで、デバイスは
 * heartbeat が途切れたら自分の判断で鳴る。管理者がタブを閉じた・別タブへ移った・
 * PC がフリーズした、のいずれも「無音」という同じ形で拾えるようにするため。
 * ダッシュボード側は unmount で disconnect() するだけでよい。
 *
 * プロトコル (firmware と同文。行指向 \n / ASCII / 115200 8N1):
 *   host → dev  `HB OK` / `HB NG <reason>`  … 3 秒ごと。デバイスは返信しない
 *   host → dev  `STATUS`                    … 機種判定のためのプローブ (arbiter が撃つ)
 *   dev  → host `STATUS alarm state=<idle|alarming|muted> cause=<none|silence|ng:<reason>|call> hb_age_ms=<n|-> VER=<ver>`
 *   dev  → host `EVT ALARM state=<...> cause=<...>` … 状態遷移のたび + 5 秒ごと無条件
 * 末尾トークン ` call=1` / ` call=0` は任意 (無ければ 0)。
 *
 * 送る中身は useActiveRooms から組み立てる:
 *   room 一覧の購読 (WebSocket) が切れている → `HB NG signaling` (着信を受けられない)
 *   それ以外                                → `HB OK`
 *   room が立っていて管理者がまだどれにも入っていない → 末尾に ` call=1` (着信中)
 *
 * 機種識別を USB 記述子では行えない: CoreS3 の BLE ゲートウェイも VoiceS3R も
 * VID 0x303A / PID 0x1001 で同一。ポートの探索・open・`STATUS` プローブは
 * useSerialArbiter が 1 本で行い、ここは「`STATUS alarm` / `EVT ALARM` が来たら
 * 自分のものだ」と名乗り出る述語と、預かったポートの使い方だけを持つ
 * (Refs ippoan/alc-app#182)。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { writeLine } from '~/composables/useSerialArbiter'

/** デバイスが報告する鳴動状態 */
export interface AlarmDeviceState {
  state: 'idle' | 'alarming' | 'muted'
  cause: string
}

/** arbiter に登録する名前 */
const CLAIMANT_NAME = 'alarm-device'

/** mount 直後は BLE ゲートウェイに先にポートを選ばせる (同居しない PC では 0 を渡す) */
const INITIAL_SCAN_DELAY = 5000
const HEARTBEAT_INTERVAL = 3000

// シングルトン: 管理者 PC につながる警告デバイスは 1 台なので状態も 1 つ
const isConnected = ref(false)
const deviceState = ref<AlarmDeviceState | null>(null)

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function useAlarmDevice() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()
  // 送る中身の素。購読の開始/停止はダッシュボード側の責務 (ここでは読むだけ)
  const rooms = useActiveRooms()

  const isSupported = arbiter.isSupported

  // --- 行の解釈 ---

  function classify(line: string): 'alarm' | 'other' | 'unknown' {
    if (line.startsWith('STATUS alarm') || line.startsWith('EVT ALARM')) return 'alarm'
    // `STATUS LAN=...` (CoreS3) / `PONG` / JSON — 警告デバイスではないと確定できる行
    if (line.startsWith('STATUS ') || line.startsWith('PONG') || line.startsWith('{')) return 'other'
    // `EVT BOOT ...` 等は無視 (判定材料にしない)
    return 'unknown'
  }

  /** `state=` / `cause=` を拾って deviceState に畳む */
  function applyLine(line: string): void {
    let state: AlarmDeviceState['state'] | null = null
    let cause = 'none'
    for (const token of line.split(' ')) {
      if (token.startsWith('state=')) state = token.slice(6) as AlarmDeviceState['state']
      else if (token.startsWith('cause=')) cause = token.slice(6)
    }
    if (state) deviceState.value = { state, cause }
  }

  function handleLine(line: string): void {
    if (classify(line) === 'alarm') applyLine(line)
  }

  // --- heartbeat ---

  function startHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): void {
    stopHeartbeat()
    void sendHeartbeat(w)
    heartbeatTimer = setInterval(() => { void sendHeartbeat(w) }, HEARTBEAT_INTERVAL)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /** 今の状態を 1 行に畳む。`HB OK` / `HB NG signaling` に着信中だけ ` call=1` を足す */
  function heartbeatLine(): string {
    const status = rooms.isWatching.value ? 'HB OK' : 'HB NG signaling'
    // room はあるが管理者がまだどれにも入っていない = 呼び出しに応答していない
    const calling = rooms.activeRooms.value.length > 0 && rooms.joinedRoomId.value === null
    return calling ? `${status} call=1` : status
  }

  async function sendHeartbeat(w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    const ok = await writeLine(w, heartbeatLine())
    // 書けなくなった = 抜線・クラッシュ → ポートを返して掴み直しへ
    if (!ok) await arbiter.release(CLAIMANT_NAME)
  }

  // --- arbiter に預ける述語とハンドラ ---

  const claimant: SerialClaimant = {
    claim: lines => lines.some(line => classify(line) === 'alarm'),
    reject: lines => lines.some(line => classify(line) === 'other'),

    onOpen(_port, _reader, w, lines) {
      isConnected.value = true
      // プローブ中に来ていた行 (名乗り出た根拠) をここで畳む
      for (const line of lines) handleLine(line)
      startHeartbeat(w)
    },

    onLine: handleLine,

    onClose() {
      isConnected.value = false
      deviceState.value = null
      stopHeartbeat()
    },
  }

  // --- 公開 API ---

  /**
   * 探索を始める。`delay` ミリ秒待って最初のスキャン、以後 10 秒ごとに再スキャン。
   * BLE ゲートウェイと同居しない管理者 PC では 0 を渡してすぐ探してよい。
   */
  function connect(delay = INITIAL_SCAN_DELAY): void {
    if (!isSupported) return
    arbiter.register(CLAIMANT_NAME, claimant)
    arbiter.start(delay)
  }

  /**
   * WebSerial の初回許可 (ユーザー操作が要る) → 許可されたら探索を始める。
   * ボタンを押した直後に待たせると「接続にならない」と見えるので 0 で始める。
   */
  async function requestPort(): Promise<void> {
    const granted = await arbiter.requestPort()
    if (granted) connect(0)
  }

  async function disconnect(): Promise<void> {
    await arbiter.unregister(CLAIMANT_NAME)
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    deviceState: readonly(deviceState),
    connect,
    disconnect,
    requestPort,
  }
}
