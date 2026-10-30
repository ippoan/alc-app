/**
 * 血圧の測定を待っている間、Vein Station の BLE ループが動いているかを 1 秒ごとに確かめる
 * (`BLE PING` → `BLE PONG run=<0|1> stage=<段> age=<ms> stuck=<0|1>`、alc-app-s3 の hub-core
 * `ble_pong_line`)。
 *
 * シリアルの `PING` は機体全体の応答しか見ないので、BLE だけが止まった回 (2026-10-30:
 * Omron 血圧計への接続の途中で止まり、USB を抜き差しするまで血圧が取れなかった) を見つけられない。
 * 機体が「今の段に何秒いるか」を返し、長すぎれば `stuck=1` になる。止まっている・返事が無いときは
 * 画面に出し、変わり目だけ診断ログ (`dev BLE ...`) に残す。
 *
 * - 旧ファーム (`ERR BLE`) は確かめられないので、その接続のあいだは送らない
 * - シリアルは同時に 1 件しか待てない。他の応答待ちとぶつかった回は飛ばす (数に入れない)
 */
import { ref, watch, onScopeDispose, type Ref } from 'vue'
import { appendDiag } from '~/utils/serialDiagLog'

/** 確かめる間隔 */
export const BLE_WATCH_INTERVAL_MS = 1_000
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
  let inFlight = false
  let noReply = 0
  let unsupported = false

  function setState(next: BleWatchState, detail: string): void {
    if (state.value === next) return
    state.value = next
    appendDiag(`dev BLE ${next} ${detail}`.trimEnd())
  }

  async function tick(): Promise<void> {
    if (inFlight || unsupported || !serial.isConnected.value) return
    inFlight = true
    try {
      const pong = parseBlePong(await serial.request('BLE PING', 'BLE PONG', BLE_PING_TIMEOUT_MS))
      noReply = 0
      if (!pong) return
      if (pong.stuck) {
        stuckStage.value = pong.stage
        setState('stuck', `stage=${pong.stage} age=${pong.ageMs ?? '-'}`)
      }
      else {
        stuckStage.value = null
        setState('ok', `stage=${pong.stage}`)
      }
    }
    catch (e) {
      if (isBusy(e)) return
      if (e instanceof Error && e.message.startsWith('ERR BLE')) {
        unsupported = true
        return
      }
      noReply += 1
      if (noReply >= NO_REPLY_LIMIT) setState('no-reply', `n=${noReply}`)
    }
    finally {
      inFlight = false
    }
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    noReply = 0
    stuckStage.value = null
    state.value = 'ok'
  }

  watch(active, (on) => {
    stop()
    if (!on) return
    void tick()
    timer = setInterval(() => void tick(), BLE_WATCH_INTERVAL_MS)
  }, { immediate: true })

  // 機体がつなぎ直されたら (ファームの書き込み後など) 旧ファームの印を外す
  watch(() => serial.isConnected.value, (connected) => {
    if (connected) unsupported = false
  })

  onScopeDispose(stop)

  return { state, stuckStage }
}
