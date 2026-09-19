/**
 * 血圧測定台 (ATOM S3 / VoiceS3R build を挿した PC) の鍵で、**測定台用**の短命
 * device JWT を取る (Refs ippoan/alc-app#353)。
 *
 * ## なぜ要るか
 *
 * 測定台は「血圧計をつないだ PC」に ATOM S3 を USB で挿し、血圧だけを測る PWA を
 * `/?role=driver&tab=bp&station=bp` で開いたもの。**`devices` テーブルに行を持たない**
 * ので、`deviceId` が構造的に空になり、admin browser JWT も キオスクの device JWT も
 * 持たない。そのままでは血圧を保存する 4 本が**無認証の X-Tenant-ID 直 fetch**
 * (`api.ts` の最後の fallback) に落ちる。
 *
 * auth-worker の許可表 (`device-data-proxy.ts` の `BP_STATION_ROUTES`) は、role
 * `device-bp-station` に**この 4 本だけ**を許している:
 *
 * ```
 * POST /api/employees/lookup        (NFC で乗務員を引く)
 * GET  /api/employees/face-data     (顔認証の突き合わせ)
 * POST /api/measurements/start
 * PUT  /api/measurements/{id}
 * ```
 *
 * 取りに行く口は運行管理者席 (#337) と同じ 2 段で、**`usage` が違うだけ**:
 *
 * ```
 * GET  /device/alarm-nonce?usage=bp-station        → { nonce }
 * POST /device/alarm-token {nonce,pubkey,sig,usage,bp_bonded} → { access_token, expires_in }
 * ```
 *
 * ## 署名は `AUTH SIGN` ではなく `AUTH SIGNBP`
 *
 * 測定台を含む全機種のファームが `AUTH SIGNBP <nonce>` →
 * `AUTH SIGBP <pubkey> <sig> BP=<1|0>` に答える (`alc-app-s3` の `handle_common`)。
 * **ボンド状態つきで署名させるのがこの端末では必須** — 測定台の `bpEnabled`
 * (= サーバの `devices.bp_enabled`) は行が無いので永久に false で、画面が
 * 「この端末で血圧を使うか」を知れる材料は**署名つきのボンド状態しか無い**。
 * 取れた値は {@link setSignedBpBond} (機種非依存の 1 か所) へ書き込み、
 * `useBpUiEnabled` の表示判定がそれを読む。
 *
 * 古いファームへの `AUTH SIGN` フォールバックは**持たない** — 測定台はまだ現場に
 * 1 台も無く (release 前)、`SIGNBP` を落とした回に `AUTH SIGN` で JWT だけ取ると
 * **ボンド状態が「不明」のまま画面が測定に進んでしまう**ため。
 *
 * ## 運行管理者席・キオスクとは完全に別勘定
 *
 * cache・single-flight・抑止 (backoff)・失敗理由は**すべてこのモジュールに閉じる**。
 * `useManagerDeviceToken.ts` の module スコープとは**共有しない** — 共有すると
 * 測定台と運行管理者席が同じ JWT を掴み、許可表の違う role で互いの口が 403 になる。
 * `useDeviceToken.ts` (キオスク) も 1 文字も触らない。storage には一切書かない
 * (ATOM S3 を抜けば期限切れとともに消える)。
 */
import { ref, readonly } from 'vue'
import { withTimeout, AUTH_WORKER_FETCH_TIMEOUT_MS } from '~/utils/fetch-timeout'

/** auth-worker が測定台の鍵に割り当てた用途。nonce (query) と token (body) の両方で使う。 */
export const BP_STATION_KEY_USAGE = 'bp-station'

/** `expires_in` 欠落時の fallback TTL (秒。運行管理者席・キオスクの署名経路と同値) */
const DEFAULT_TTL_SECONDS = 900
/** 期限ギリギリの token を返さないための手前マージン (ms) */
const REFRESH_BEFORE_MS = 60_000
/** 失敗してから、これだけ再試行しない (ms)。兄弟の署名経路と同じ長さ */
const BACKOFF_MS = 60_000
/** `AUTH SIGN` 系コマンドと同じ 10 秒 (utils/alarm-sign.ts の AUTH_SIGN_TIMEOUT_MS と同値) */
const AUTH_SIGNBP_TIMEOUT_MS = 10_000
const AUTH_SIGNBP_MATCH_PREFIX = 'AUTH SIGBP '

/**
 * どの段で落ちたか (`useManagerDeviceToken.ManagerTokenFailureStage` と同じ流儀)。
 * - `no-bp-station`: ATOM S3 が USB で繋がっていない (署名を頼む相手が居ない)
 * - `nonce`: `/device/alarm-nonce?usage=...` の取得
 * - `sign`: ATOM S3 への署名要求 (`AUTH SIGNBP`)
 * - `token-exchange`: `/device/alarm-token` の交換 (**鍵が用途「測定台」で未登録なら 401 でここ**)
 */
export type BpStationTokenFailureStage = 'no-bp-station' | 'nonce' | 'sign' | 'token-exchange'

/** ボンド状態つき署名 (`AUTH SIGNBP`) の parse 結果。 */
interface BpStationSignature {
  pubkey: string
  sig: string
  /** 血圧計がボンド済みか。`BP=1` なら true、`BP=0` なら false */
  bpBonded: boolean
}

/**
 * `AUTH SIGBP <pubkey> <sig> BP=1` / `AUTH SIGBP <pubkey> <sig> BP=0` を space で
 * 分割して parse。4 語目は大文字の `BP=1` / `BP=0` のみを受け付ける
 * (署名対象の小文字 `bp=` とは別物)。形式が合わなければ null。
 */
export function parseBpStationSigLine(line: string): BpStationSignature | null {
  const parts = line.split(' ')
  if (parts.length !== 5 || parts[0] !== 'AUTH' || parts[1] !== 'SIGBP') return null
  const bp = parts[4]
  if (bp !== 'BP=0' && bp !== 'BP=1') return null
  return { pubkey: parts[2]!, sig: parts[3]!, bpBonded: bp === 'BP=1' }
}

// --- module スコープ (測定台の PC に 1 つ。運行管理者席・キオスクの cache とは別物) ---
const cachedJwt = ref<string | null>(null)
let cachedExpMs = 0
let inFlight: Promise<string | null> | null = null
const backoffUntil = ref(0)
const lastError = ref<string | null>(null)
const lastFailureStage = ref<BpStationTokenFailureStage | null>(null)
const lastFailureStatus = ref<number | null>(null)
// ATOM S3 の抜き差し監視を二重登録しないためのガード (useDeviceToken と同じ流儀)
let deviceListenersInstalled = false

/**
 * 失敗を 1 行だけコンソールに出す。**出すのは段と HTTP status だけ** —
 * token・nonce・署名・pubkey は先頭数文字でも出さない (兄弟の署名経路と同じ方針)。
 */
function warnFailure(stage: BpStationTokenFailureStage, status: number | null): void {
  console.warn(`[useBpStationDeviceToken] 測定台トークンの取得に失敗 stage=${stage} status=${status ?? '-'}`)
}

export function useBpStationDeviceToken() {
  const config = useRuntimeConfig()
  // nuxt.config が既定値を持つので fallback は置かない (useManagerDeviceToken と同じ流儀)
  const authWorkerUrl = (config.public.authWorkerUrl as string).replace(/\/$/, '')
  const atom = useAtomS3Serial()

  /**
   * `AUTH SIGNBP <nonce>` を送り、応答を parse する。ファームが `ERR AUTH: ...` を
   * 返せば request がそのまま reject するので、ここでは投げっぱなしにする
   * (呼び出し側が段 `sign` として理由を残す)。parse に失敗したときだけ null。
   */
  async function signBondedNonce(nonce: string): Promise<BpStationSignature | null> {
    const line = await atom.request(`AUTH SIGNBP ${nonce}`, AUTH_SIGNBP_MATCH_PREFIX, AUTH_SIGNBP_TIMEOUT_MS)
    return parseBpStationSigLine(line)
  }

  /**
   * 実際に 1 本取りに行く。失敗したら null を返し、`BACKOFF_MS` の間は再試行しない
   * (呼び出し側 = `api.ts` は**キオスクの鍵へ落とさず**、理由を載せたエラーを投げる)。
   *
   * どの失敗経路でも {@link setSignedBpBond} を必ず通る — 黙って帰ると画面が
   * 永久に `checking` (スピナー) のまま止まるため (`useSignedBpBond.ts` の doc)。
   */
  async function mint(nowMs: number): Promise<string | null> {
    if (nowMs < backoffUntil.value) return null

    // ★ ここでは**抑止 (backoff) を立てない** — 「まだ挿していない」だけのことがあり、
    // 挿した直後の 1 回目で通ってほしいため (useManagerDeviceToken の no-alarm-device と同じ扱い)。
    if (!atom.isConnected.value) {
      // 結果の真偽ではなく接続を見直す (useDeviceToken の startupProbe と同じ役どころ)。
      // arbiter への登録はここで残るので、後から挿されれば onOpen で取り直しに行く
      await atom.connect()
      if (!atom.isConnected.value) {
        lastError.value = '測定台の ATOM S3 が USB で繋がっていません'
        lastFailureStage.value = 'no-bp-station'
        lastFailureStatus.value = null
        // 署名を頼む相手が居ない = ボンド状態は「不明」(「未ボンド」ではない)。
        // 探索まではしたので「試した」= 画面は判定してよい
        setSignedBpBond(null)
        warnFailure('no-bp-station', null)
        return null
      }
    }

    lastError.value = null
    lastFailureStage.value = null
    lastFailureStatus.value = null
    // throw した時点の値がそのまま失敗の段になる
    let stage: BpStationTokenFailureStage = 'nonce'
    let status: number | null = null
    try {
      // ★ usage は query にも body にも要る (片方だけだと auth-worker が 401)
      const nonceRes = await fetch(
        `${authWorkerUrl}/device/alarm-nonce?usage=${BP_STATION_KEY_USAGE}`,
        withTimeout({}, AUTH_WORKER_FETCH_TIMEOUT_MS),
      )
      if (!nonceRes.ok) {
        status = nonceRes.status
        throw new Error(`alarm-nonce http ${nonceRes.status}`)
      }
      const nonceData = (await nonceRes.json()) as { nonce?: string }
      if (!nonceData.nonce) throw new Error('alarm-nonce: nonce 欠落')

      stage = 'sign'
      // 送り先は測定台の ATOM S3。`AUTH SIGN` へは落とさない (上の doc)
      const signed = await signBondedNonce(nonceData.nonce)
      if (!signed) throw new Error('AUTH SIGBP の parse に失敗')

      stage = 'token-exchange'
      const tokenRes = await fetch(`${authWorkerUrl}/device/alarm-token`, withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: nonceData.nonce,
          pubkey: signed.pubkey,
          sig: signed.sig,
          usage: BP_STATION_KEY_USAGE,
          // ボンド状態は**署名に含まれた値**をそのままサーバへ渡す (キオスク経路と同じ)
          bp_bonded: signed.bpBonded,
        }),
      }, AUTH_WORKER_FETCH_TIMEOUT_MS))
      if (!tokenRes.ok) {
        status = tokenRes.status
        // 鍵が用途「測定台」で未登録ならここに 401 で来る (`/device/setup` の登録待ち)
        throw new Error(`alarm-token http ${tokenRes.status}`)
      }
      const tokenData = (await tokenRes.json()) as { access_token?: string, expires_in?: number }
      if (!tokenData.access_token) throw new Error('alarm-token: access_token 欠落')

      const ttl = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : DEFAULT_TTL_SECONDS
      cachedJwt.value = tokenData.access_token
      cachedExpMs = nowMs + ttl * 1000
      // いま発行された JWT に乗っているボンド状態 — サーバの判断と一致する唯一の材料
      setSignedBpBond(signed.bpBonded)
      return cachedJwt.value
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      lastFailureStage.value = stage
      lastFailureStatus.value = status
      backoffUntil.value = nowMs + BACKOFF_MS
      // 署名が JWT まで届かなかった回は、サーバにボンド状態が渡っていない = 「不明」
      setSignedBpBond(null)
      warnFailure(stage, status)
      return null
    }
  }

  /**
   * 測定台用 device JWT を返す (cache → ATOM S3 の署名)。取れなければ null。
   * 同時呼び出しは 1 本にまとめる (画面が顔データと乗務員検索を同時に読むため)。
   */
  async function getBpStationJwt(): Promise<string | null> {
    const nowMs = Date.now()
    if (cachedJwt.value && cachedExpMs - REFRESH_BEFORE_MS > nowMs) return cachedJwt.value

    if (!inFlight) {
      inFlight = mint(nowMs).finally(() => { inFlight = null })
    }
    return inFlight
  }

  // ATOM S3 の抜き差しに追随する。抜けたら JWT は無効 (その端末の鍵で出たもの)、
  // 挿し直されたら抑止を解いて取り直す — **挿し忘れて開いた画面が、挿した時点で
  // 動き出す**ために要る (抑止のままだと最大 60 秒「血圧計が見つかりません」が残る)。
  if (!deviceListenersInstalled) {
    deviceListenersInstalled = true
    atom.onClose(() => {
      cachedJwt.value = null
      cachedExpMs = 0
    })
    atom.onOpen(() => {
      backoffUntil.value = 0
      void getBpStationJwt()
    })
  }

  return {
    getBpStationJwt,
    /** 直近の失敗理由。成功 / 未試行なら null */
    lastError: readonly(lastError),
    /** 直近の失敗がどの段で起きたか。成功 / 未試行なら null */
    lastFailureStage: readonly(lastFailureStage),
    /** 直近の失敗の HTTP status。HTTP を伴わない失敗 / 成功 / 未試行なら null */
    lastFailureStatus: readonly(lastFailureStatus),
    /** 再試行を抑止している期限 (ms epoch)。0 なら抑止していない */
    backoffUntil: readonly(backoffUntil),
  }
}
