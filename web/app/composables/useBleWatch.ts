/**
 * 血圧の測定を待っている間、Vein Station の BLE ループが動いているかを 1 秒ごとに確かめる
 * (`BLE PING` → `BLE PONG run=<0|1> stage=<段> age=<ms> stuck=<0|1>`、alc-app-s3 の hub-core
 * `ble_pong_line`)。
 *
 * シリアルの `PING` は機体全体の応答しか見ないので、BLE だけが止まった回 (2026-10-30:
 * Omron 血圧計への接続の途中で止まり、USB を抜き差しするまで血圧が取れなかった) を見つけられない。
 * 機体が「今の段に何秒いるか」を返し、長すぎれば `stuck=1` になる。止まっている・返事が無いときは
 * 画面に出す。診断ログには集計の 1 行だけ残す (下)。
 *
 * - 送るのは 1 回の待ちにつき最大 2 分 ({@link BLE_WATCH_MAX_MS})
 * - 測定を待ち終えたら (2 分で打ち切った回も)、その間の集計を 1 行だけ残す (`dev BLE ping sent=… ok=…
 *   busy=… fail=… stuck=… max_age=… stages=…`)。返事が来ていたか・止まっていたかを後からログで確かめる
 * - 旧ファーム (`ERR BLE`) は確かめられないので、その接続のあいだは送らない
 * - シリアルは同時に 1 件しか待てない。他の応答待ちとぶつかった回は飛ばす (数に入れない)
 */
import { ref, watch, onScopeDispose, type Ref } from 'vue'
import { appendDiag } from '~/utils/serialDiagLog'

/** 確かめる間隔 */
export const BLE_WATCH_INTERVAL_MS = 1_000
/** 1 回の待ちで送り続ける上限。過ぎたら止めて集計を残す (画面を開いたまま放置された回に送り続けない) */
export const BLE_WATCH_MAX_MS = 120_000
/** 1 回の応答待ち。間隔より短くして、次の回と重ならないようにする */
const BLE_PING_TIMEOUT_MS = 800
/** 返事が無い回がこれだけ続いたら「返事が無い」と出す */
const NO_REPLY_LIMIT = 3

export type BleWatchState = 'ok' | 'stuck' | 'no-reply'

interface BleWatchSerial {
  isConnected: Readonly<Ref<boolean>>
  request: (line: string, matchPrefix: string, timeoutMs: number) => Promise<string>
}

/** `BLE PONG …` の `stage=` / `age=` / `stuck=` を読む。形が違えば null */
export function parseBlePong(line: string): { stage: string, ageMs: number | null, stuck: boolean } | null {
  const m = /stage=(\S+) age=(\S+) stuck=([01])/.exec(line)
  if (!m) return null
  const age = Number(m[2])
  return { stage: m[1]!, ageMs: Number.isFinite(age) ? age : null, stuck: m[3] === '1' }
}

/** 応答待ちがぶつかったとき (`request(...): 既に応答待ちです`) の Error か */
function isBusy(e: unknown): boolean {
  return e instanceof Error && e.message.includes('既に応答待ち')
}

export function useBleWatch(serial: BleWatchSerial, active: Readonly<Ref<boolean>>) {
  const state = ref<BleWatchState>('ok')
  /** 止まっている段 (`stuck` のときだけ) */
  const stuckStage = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let noReply = 0
  let unsupported = false
  // 測定を待っている 1 回ぶんの集計 (待ち終えたら 1 行残す)
  let sent = 0
  let replied = 0
  let busy = 0
  let failed = 0
  let stuckCount = 0
  let maxAgeMs: number | null = null
  const stages = new Set<string>()

  function resetSummary(): void {
    sent = 0
    replied = 0
    busy = 0
    failed = 0
    stuckCount = 0
    maxAgeMs = null
    stages.clear()
  }

  function flushSummary(): void {
    if (sent === 0) return
    const parts = unsupported
      ? ['unsupported']
      : [`sent=${sent}`, `ok=${replied}`, `busy=${busy}`, `fail=${failed}`, `stuck=${stuckCount}`, `max_age=${maxAgeMs ?? '-'}`, `stages=${[...stages].join(',') || '-'}`]
    appendDiag(`dev BLE ping ${parts.join(' ')}`)
    resetSummary()
  }


  async function tick(): Promise<void> {
    if (inFlight || unsupported || !serial.isConnected.value) return
    inFlight = true
    sent += 1
    try {
      const pong = parseBlePong(await serial.request('BLE PING', 'BLE PONG', BLE_PING_TIMEOUT_MS))
      noReply = 0
      replied += 1
      if (!pong) return
      stages.add(pong.stage)
      if (pong.ageMs !== null) maxAgeMs = Math.max(maxAgeMs ?? 0, pong.ageMs)
      if (pong.stuck) stuckCount += 1
      stuckStage.value = pong.stuck ? pong.stage : null
      state.value = pong.stuck ? 'stuck' : 'ok'
    }
    catch (e) {
      if (isBusy(e)) {
        busy += 1
        return
      }
      if (e instanceof Error && e.message.startsWith('ERR BLE')) {
        unsupported = true
        return
      }
      failed += 1
      noReply += 1
      if (noReply >= NO_REPLY_LIMIT) state.value = 'no-reply'
    }
    finally {
      inFlight = false
    }
  }

  function stop(): void {
    flushSummary()
    if (timer) clearInterval(timer)
    if (deadline) clearTimeout(deadline)
    timer = null
    deadline = null
    noReply = 0
    stuckStage.value = null
    state.value = 'ok'
  }

  watch(active, (on) => {
    stop()
    if (!on) return
    void tick()
    timer = setInterval(() => void tick(), BLE_WATCH_INTERVAL_MS)
    deadline = setTimeout(stop, BLE_WATCH_MAX_MS)
  }, { immediate: true })

  // 機体がつなぎ直されたら (ファームの書き込み後など) 旧ファームの印を外す
  watch(() => serial.isConnected.value, (connected) => {
    if (connected) unsupported = false
  })

  onScopeDispose(stop)

  return { state, stuckStage }
}
