/**
 * 開発用の端末だけの「指静脈の確認」タブのロジック (Refs ippoan/alc-app#436)。
 *
 * ファームの試験コマンド (`VEIN TEST ENROLL|VERIFY|CLEAR`) を、普段の画面 (血圧測定・キオスク) の
 * 自動照合と取り合わずに打つ。このタブには自動照合の購読者を置かないので、指を置いても
 * 画面側の照合は走らない。
 *
 * - モジュールの試験用 ID は {@link VEIN_TEST_ID} (2) に固定する
 * - 送信は `sendVeinDevLine` (useVeinDevPort の allowlist) だけを通す。別の allowlist を持たない
 * - 1 件ずつ (実行中は `busy`)。ポートが「既に応答待ち」のときだけ間を置いて呼び直す
 * - **生体データは画面にもログにも出さない。** VERIFY の DATA は先頭 {@link VERIFY_DATA_SHOWN_BYTES}
 *   バイトまで
 * - 送った行と結果は `appendDiag` に貯める (arbiter の request は行を記録しないため、ここで残す)
 *
 * タブを離れる (`dispose`) と、以後の行は送らない。すでに送った行の応答待ちは arbiter の
 * timeout (登録 25 秒・照合 20 秒) まで残りうる — 戻った先の自動照合が「既に応答待ち」になるのは
 * その間だけ
 */

import { computed, ref } from 'vue'
import { sendVeinDevLine, type VeinRequest } from '~/composables/useVeinDevPort'
import { requestWhenFree } from '~/utils/serial-request-when-free'
import { appendDiag } from '~/utils/serialDiagLog'
import { clearVeinTemplates } from '~/utils/vein-db'
import { resetVeinSyncClock } from '~/utils/vein-identify'

/** モジュールの試験用 ID (2〜9 のうち固定の 1 つ) */
export const VEIN_TEST_ID = 2

const ENROLL_TIMEOUT_MS = 25_000
const VERIFY_TIMEOUT_MS = 20_000
const CLEAR_TIMEOUT_MS = 5_000
const FINGER_TIMEOUT_MS = 3_000
/** 指の状態を聞き直す間隔と、指を待つ上限 */
export const FINGER_POLL_MS = 300
export const FINGER_WAIT_MS = 30_000
/** 指が置かれてから照合を送るまでの間 (指を落ち着かせる) */
export const VERIFY_SETTLE_MS = 700
/** 「既に応答待ち」の呼び直し */
const BUSY_RETRY_MS = 300
const BUSY_RETRY_LIMIT = 40
/** VERIFY の DATA を画面に出す長さ (バイト) */
export const VERIFY_DATA_SHOWN_BYTES = 8

/** 指の案内。`place` = 置いて / `release` = 離して */
export type VeinTestGuide = 'none' | 'place' | 'release'

export interface VeinTestResult {
  kind: 'enrolled' | 'cleared' | 'local-cleared' | 'match' | 'mismatch' | 'other'
  /** そのまま画面に出す文 */
  text: string
}

export interface VeinTestDeps {
  request: VeinRequest
  /** 手元の写しを消す (既定: vein-db の clear + 同期時計のリセット) */
  clearLocal?: () => Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

async function defaultClearLocal(): Promise<void> {
  await clearVeinTemplates()
  resetVeinSyncClock()
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * `VEIN TEST VERIFY <id> RC=<2 桁> DATA=<hex>` を RC と DATA の先頭 8 バイトに分ける。
 * 形が違えば null
 */
export function parseVerifyReply(line: string): { rc: string, data: string } | null {
  const m = /RC=([0-9A-Fa-f]{2}) DATA=([0-9A-Fa-f]*)/.exec(line)
  if (!m) return null
  return { rc: m[1]!.toUpperCase(), data: m[2]!.slice(0, VERIFY_DATA_SHOWN_BYTES * 2).toUpperCase() }
}

export function useVeinTest(deps: VeinTestDeps) {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const clearLocal = deps.clearLocal ?? defaultClearLocal

  const busy = ref(false)
  const guide = ref<VeinTestGuide>('none')
  const result = ref<VeinTestResult | null>(null)
  const error = ref<string | null>(null)
  const matched = ref(0)
  const tried = ref(0)
  /** 送った行と受けた行 (生体データを含まない形に切ったもの) */
  const lines = ref<string[]>([])
  let disposed = false

  const summary = computed(() => `一致 ${matched.value} / 試行 ${tried.value}`)

  function note(message: string): void {
    appendDiag(`vein-test ${message}`)
    lines.value = [...lines.value, message].slice(-20)
  }

  /** 1 行送って応答を待つ。「既に応答待ち」のときだけ呼び直す。タブを離れたら送らない */
  async function send(line: string, matchPrefix: string, timeoutMs: number, shown?: (reply: string) => string): Promise<string> {
    if (disposed) throw new Error('タブを離れたので中止しました')
    note(`送 ${line}`)
    try {
      const reply = await requestWhenFree(
        () => sendVeinDevLine(deps.request, line, matchPrefix, timeoutMs),
        { intervalMs: BUSY_RETRY_MS, maxRetries: BUSY_RETRY_LIMIT, isCancelled: () => disposed },
      )
      note(`受 ${shown ? shown(reply) : reply}`)
      return reply
    }
    catch (e) {
      note(`失敗 ${errorText(e)}`)
      throw e
    }
  }

  /** 指の有無を 1 回聞く。`VEIN FINGER 1|0` */
  async function fingerPresent(): Promise<boolean> {
    const reply = await send('VEIN FINGER?', 'VEIN FINGER', FINGER_TIMEOUT_MS)
    return reply.trim().endsWith('1')
  }

  /** 指の有無が `want` になるまで聞き直す。上限を過ぎたら投げる */
  async function waitFinger(want: boolean): Promise<void> {
    const deadline = now() + FINGER_WAIT_MS
    guide.value = want ? 'place' : 'release'
    while ((await fingerPresent()) !== want) {
      if (now() >= deadline) {
        throw new Error(want ? '指が置かれませんでした' : '指が離れませんでした')
      }
      await sleep(FINGER_POLL_MS)
    }
  }

  async function run(job: () => Promise<VeinTestResult>): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    result.value = null
    try {
      result.value = await job()
    }
    catch (e) {
      error.value = errorText(e)
    }
    finally {
      guide.value = 'none'
      busy.value = false
    }
  }

  const clearLine = `VEIN TEST CLEAR ${VEIN_TEST_ID}`
  const clearedPrefix = `VEIN TEST CLEARED ${VEIN_TEST_ID}`

  /** 登録: 前の登録を消す → 指を待つ → 登録 */
  function enroll(): Promise<void> {
    return run(async () => {
      // 未登録の ID の CLEAR は失敗で返る。消す目的は「空にする」なので失敗は無視する
      await send(clearLine, clearedPrefix, CLEAR_TIMEOUT_MS).catch(() => {
        if (disposed) throw new Error('タブを離れたので中止しました')
      })
      await waitFinger(true)
      guide.value = 'none'
      await send(`VEIN TEST ENROLL ${VEIN_TEST_ID}`, `VEIN TEST ENROLLED ${VEIN_TEST_ID}`, ENROLL_TIMEOUT_MS)
      return { kind: 'enrolled', text: `ID ${VEIN_TEST_ID} に登録しました。指を離してください` }
    })
  }

  /** 照合: 指が離れる → 置かれる → 少し待つ → 照合。回数を数える */
  function verify(): Promise<void> {
    return run(async () => {
      await waitFinger(false)
      await waitFinger(true)
      guide.value = 'none'
      await sleep(VERIFY_SETTLE_MS)
      const shown = (reply: string) => {
        const p = parseVerifyReply(reply)
        return p ? `VEIN TEST VERIFY ${VEIN_TEST_ID} RC=${p.rc} DATA=${p.data}` : reply
      }
      tried.value += 1
      const reply = await send(
        `VEIN TEST VERIFY ${VEIN_TEST_ID}`,
        `VEIN TEST VERIFY ${VEIN_TEST_ID} `,
        VERIFY_TIMEOUT_MS,
        shown,
      )
      const p = parseVerifyReply(reply)
      if (!p) return { kind: 'other', text: `応答の形が読めません: ${reply.slice(0, 80)}` }
      // RC=00 は成功 (一致)、RC=01 は失敗 (DATA の先頭が理由コード)。理由の意味は実機で確かめる途中なので、
      // 名前を付けず値をそのまま出す
      if (p.rc === '00') {
        matched.value += 1
        return { kind: 'match', text: `一致しました (RC=00 DATA=${p.data})` }
      }
      if (p.rc === '01') return { kind: 'mismatch', text: `一致しませんでした (RC=01 DATA=${p.data})` }
      return { kind: 'other', text: `RC=${p.rc} DATA=${p.data}` }
    })
  }

  /** 消す: モジュールの ID 2 の登録を消す (試験の後片付け) */
  function clearModule(): Promise<void> {
    return run(async () => {
      await send(clearLine, clearedPrefix, CLEAR_TIMEOUT_MS)
      return { kind: 'cleared', text: `ID ${VEIN_TEST_ID} の登録を消しました` }
    })
  }

  /** この端末の手元の写し (オフライン照合用) を消す。モジュールには触れない */
  function clearLocalCopy(): Promise<void> {
    return run(async () => {
      note('手元の写しを消す')
      await clearLocal()
      return { kind: 'local-cleared', text: '端末の手元の写しを消しました。次の同期で取り直します' }
    })
  }

  /** タブを離れた: 以後の行は送らない */
  function dispose(): void {
    disposed = true
  }

  return {
    busy,
    guide,
    result,
    error,
    matched,
    tried,
    summary,
    lines,
    enroll,
    verify,
    clearModule,
    clearLocalCopy,
    dispose,
  }
}
