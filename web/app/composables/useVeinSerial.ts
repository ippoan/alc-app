/**
 * Vein Station (指静脈読み取り端末、`atoms3-timecard` の `vein` build = Atom VoiceS3R +
 * `--features vein`) との USB シリアル接続。useSerialArbiter の利用側
 * (Refs ippoan/vein-match#20)。
 *
 * 端末は `DEVICE timecard …` と名乗る (alc-app-s3 `crates/hub-core/src/protocol.rs` の
 * `HostKind::Timecard`)。機種識別を USB 記述子では行えない理由・`DEVICE` プローブの
 * 仕組みは useAtomS3Serial / useSerialArbiter の doc と同じ (Refs ippoan/alc-app#182, #353)。
 * ここは預かったポートの使い方 (`VEIN CAPTURE` / `VEIN SAY <x>`) だけを持つ。
 *
 * 正本: alc-app-s3 `docs/console-protocol.md` (ippoan/alc-app-s3#274)。
 *   `VEIN CAPTURE` → 成功 `VEIN CHARA <hex>` (1 行)。失敗 `ERR VEIN <reason>`。
 *     指を待つので応答まで最大 15 秒強
 *   `VEIN SAY <PLACE|AGAIN|ENROLLED|FAILED>` → `OK VEIN SAY <x>`。スピーカーが
 *     使えない機は `ERR VEIN NO_SPEAKER`
 *   `vein` を入れていない端末はどちらも `ERR VEIN: unsupported`
 *
 * `useSerialArbiter.request()` は同時に 1 件しか待てない — capture の応答を待っている
 * 間に say を送らない (呼び出し側の責務、register.vue の手順が順に呼ぶだけで満たす)。
 */

import type { SerialClaimant } from '~/composables/useSerialArbiter'
import { TIMECARD_DEVICE_KIND } from '~/composables/useSerialArbiter'

/**
 * arbiter に登録する名前。`DEVICE timecard` の kind と一致させる — 語彙の正本は arbiter 側
 * (`TIMECARD_DEVICE_KIND`)
 */
const CLAIMANT_NAME = TIMECARD_DEVICE_KIND

/** connect() が claim を待つ上限 (useAtomS3Serial / useCoreS3Serial と同じ値・同じ意味) */
const CLAIM_TIMEOUT = 3000

/** `VEIN CAPTURE` の応答上限。ファームは 1 回の指待ちで最大 15 秒強かかるので余裕を足す */
const CAPTURE_TIMEOUT_MS = 20000

/** `VEIN SAY` は読み取り中でもすぐ鳴るので capture より短くてよい */
const SAY_TIMEOUT_MS = 5000

// シングルトン: 1 台の PC につながる Vein Station は 1 台
const isConnected = ref(false)

/** claim を待っている connect() */
const waiters = new Set<() => void>()

/**
 * `ERR VEIN <reason>` / `ERR VEIN: unsupported` から reason だけを取り出す。
 * `useSerialArbiter.request()` の reject は `ERR VEIN ...` 以降を丸ごと Error.message に
 * するので (`errPrefix` からの slice)、先頭の `ERR VEIN` とその後ろの `:`/空白を落とす。
 * `ERR VEIN` を含まない message (timeout 等) はそのまま返す。
 */
function extractVeinErrReason(message: string): string {
  const at = message.indexOf('ERR VEIN')
  if (at === -1) return message
  return message.slice(at + 'ERR VEIN'.length).replace(/^[:\s]+/, '')
}

export function useVeinSerial() {
  // ポートの探索と調停は arbiter に任せる (navigator.serial を自前で叩かない)
  const arbiter = useSerialArbiter()
  const isSupported = arbiter.isSupported

  // --- arbiter に預けるハンドラ ---
  //
  // capture/say の応答は全部 arbiter.request() の pendingRequest 横取りで拾われる
  // (Refs useSerialArbiter.probe の doc)。それ以外の行は Vein Station から来ない想定
  // なので onLine は何もしない。

  const claimant: SerialClaimant = {
    onOpen() {
      isConnected.value = true
      for (const notify of [...waiters]) notify()
    },

    onLine() { /* capture/say の応答は request() が横取りする。他に来る行は無い */ },

    onClose() {
      isConnected.value = false
    },
  }

  /** 呼ぶ前に connect() が接続済みを弾いているので、ここは必ず未接続から始まる */
  function waitForClaim(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onClaim = (): void => {
        clearTimeout(timer)
        waiters.delete(onClaim)
        resolve(true)
      }
      const timer = setTimeout(() => {
        waiters.delete(onClaim)
        resolve(false)
      }, CLAIM_TIMEOUT)
      waiters.add(onClaim)
    })
  }

  /**
   * arbiter に自分を登録して claim を待つ。`delay` ミリ秒後に最初のスキャン。
   * 待ちが切れても登録は残るので、以後 10 秒ごとの再スキャンで拾われる。
   */
  async function connect(delay = 0): Promise<boolean> {
    if (!isSupported) return false
    if (isConnected.value) return true
    arbiter.register(CLAIMANT_NAME, claimant)
    arbiter.start(delay)
    return await waitForClaim()
  }

  /** 登録を解いてポートを返す (探索も止まる) */
  async function disconnect(): Promise<void> {
    await arbiter.unregister(CLAIMANT_NAME)
  }

  /**
   * 指を読ませて特徴量の hex を 1 回取得する。
   *
   * 成功: `VEIN CHARA <hex>` から hex 部分を返す。
   * 失敗: `ERR VEIN <reason>` (または `ERR VEIN: unsupported`) の reason を message にした
   * Error を投げる (`NO_MODULE` / `TIMEOUT` / `NO_FINGER` / `READ_FAIL` / `RC=<hex2桁>` /
   * `unsupported`)。arbiter.request() 自体がタイムアウトしたときはそのメッセージのまま
   * (`ERR VEIN` を含まないので {@link extractVeinErrReason} が素通しする)。
   *
   * `arbiter.request()` の reject は必ず `Error` (Refs useSerialArbiter.request の doc:
   * 未預かり/多重応答待ち/timeout/write失敗/ERR いずれも `new Error(...)`) なので、
   * ここでは `instanceof` を確かめずに `Error` として扱う (到達しない分岐を作らない)。
   */
  async function capture(): Promise<string> {
    let line: string
    try {
      line = await arbiter.request(CLAIMANT_NAME, 'VEIN CAPTURE', 'VEIN CHARA', CAPTURE_TIMEOUT_MS)
    } catch (e) {
      throw new Error(extractVeinErrReason((e as Error).message))
    }
    return line.slice('VEIN CHARA '.length)
  }

  /**
   * 端末のスピーカーで案内を鳴らす。
   *
   * `ERR VEIN NO_SPEAKER` (スピーカーが使えない機) は**失敗にしない** — 音声が無くても
   * 登録の手順は続ける (親の決定)。それ以外の失敗 (`unsupported` 等) はそのまま投げる。
   */
  async function say(x: 'PLACE' | 'AGAIN' | 'ENROLLED' | 'FAILED'): Promise<void> {
    try {
      await arbiter.request(CLAIMANT_NAME, `VEIN SAY ${x}`, 'OK VEIN SAY', SAY_TIMEOUT_MS)
    } catch (e) {
      if (extractVeinErrReason((e as Error).message) === 'NO_SPEAKER') return
      throw e
    }
  }

  /**
   * 預かったポートで `arbiter.request()` をそのまま撃つ (シリアル OTA 用の口、
   * Refs ippoan/alc-app-s3#279)。station も vein も `DEVICE timecard` でこの claimant が
   * 握るので、`useSerialOta` はここ経由でポートを使う (2 本目の claimant を立てない)。
   * 同時に 1 件しか待てないのは capture/say と同じ — 呼び出し側 (キオスク) が待機画面で
   * 指静脈を読んでいないときだけ使う。
   */
  function request(line: string, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string>
  function request(bytes: Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix: string): Promise<string>
  function request(payload: string | Uint8Array, matchPrefix: string, timeoutMs: number, errPrefix?: string): Promise<string> {
    // 実装側の引数は union なので、arbiter のどちらの overload にも当てはまるよう
    // バイト列 overload (errPrefix 必須) の形に寄せて渡す
    return arbiter.request(CLAIMANT_NAME, payload as Uint8Array, matchPrefix, timeoutMs, errPrefix as string)
  }

  return {
    isSupported,
    isConnected: readonly(isConnected),
    connect,
    disconnect,
    capture,
    say,
    request,
  }
}
