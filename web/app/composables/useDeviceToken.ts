/**
 * キオスク端末用 device JWT の取得 (#434 step 3c の中核)。
 *
 * auth-worker の device pairing (`/device/pair`, role=device-kiosk) で発行された
 * **device credential** (`device_id` + `device_secret`) を localStorage に保持し、
 * runtime で auth-worker `/device/token` に提示して **短命 device JWT** (1h) を
 * mint する。キオスクはこの device JWT を `Authorization: Bearer` で alc-app の
 * server proxy (`/api/proxy/*`, #434 Option ①) に送る。
 *
 * - credential (device_id + device_secret) は pairing で 1 度だけ取得・保存する。
 *   device_secret は auth-worker 側では hash 保存・再取得不可。
 * - device JWT は 1h なので expiry の 60s 手前まで cache を再利用する。
 * - credential 無し / mint 失敗時は null を返す (呼び出し側は従来の X-Tenant-ID
 *   経路に fallback できる = 段階移行で非破壊)。
 *
 * NOTE: 既存の `useAuth` が持つ `alc_device_id` は **rust-alc-api の devices
 * テーブル id** であり、ここで扱う auth-worker の device credential とは別系統。
 * 混同を避けるため別 localStorage key (`alc_kiosk_device_*`) を使う。
 *
 * ## CoreS3 の署名による短命端末 JWT (#231 → #234-2 で署名の相手を CoreS3 に変更)
 *
 * 運行管理者の PC には credential を発行・保存しない (ログイン無しの共用 PC のため)。
 * 代わりに、CoreS3 (統合ハブ) が USB で挿さっている間だけ、その ed25519 鍵の署名で
 * auth-worker (ippoan/auth-worker#552) から `aud=device, role=device-kiosk` の
 * 短命 JWT (900 秒) を取り、**このモジュールと同じメモリ cache** に載せる
 * (storage には一切書かない — 抜線すれば次の getDeviceJwt() で消える。CoreS3 の
 * `onClose` でも即座にキャッシュを捨てる)。
 * `getDeviceJwt()` の優先順位は「cache → CoreS3 署名 → 既存 credential」。
 *
 * 警告デバイス (VoiceS3R) は運行管理者の機器で LAN が無く、認証には使わない
 * (ユーザー決定。Refs ippoan/alc-app#234)。
 *
 * - 署名の取り方 (`AUTH SIGN <nonce>` → `AUTH SIG <pubkey> <sig>` parse) は
 *   `useDeviceLogin.ts` の `signAlarmDeviceNonce` を共有する (#214 と同じ firmware I/F。
 *   送り先は `useCoreS3Serial().request` を渡す)。
 * - 同時呼び出しは 1 本にまとめる (`jwtInFlight`)。
 * - 失敗 (ERR / 401 `{error:"invalid_alarm_token"}` / 429 / タイムアウト / 通信エラー、
 *   いずれも HTTP status だけで判定する) したら `CORE_S3_BACKOFF_MS` の間 CoreS3 署名経路を
 *   試さず credential 経路へ落ちる。再接続での解除はしない (次に呼ばれたとき抑止期間が
 *   過ぎていれば自然に再試行する)。失敗理由は `lastError` に残し、成功したら null に戻す。
 * - `/device/alarm-token` の応答に載る `tenant_id` が `deviceTenantId` と食い違っても
 *   **拒否しない** (発行元 auth-worker 側の判断を尊重する)。ただし**出し方は 2 つに分ける**:
 *   - `deviceTenantId` が**未設定** … `console.debug`。**平常運転**であって異常ではない —
 *     上に書いたとおり**運行管理者の PC には credential を発行・保存しない**設計なので、
 *     CoreS3 に紐づく共用 PC では**必ず**食い違う。ここで警告を出すと常時鳴り続け、
 *     **読み飛ばす習慣がついて下の本物の異常を隠す**
 *   - `deviceTenantId` が**設定済みで食い違う** … `console.warn`。テナント A に登録した
 *     端末が B のトークンを受け取っている。**明らかに異常**
 * - 起動時の 1 本 (`startupDeviceJwt`、Refs #238): 最初の `getDeviceJwt()` を起動から 1 回だけ作って
 *   共有する (CoreS3 の探索を最大 3 秒待ち、繋がっていれば署名で取る)。`isStartupJwtPending` は
 *   その 1 本が未解決かつ起動から 3 秒以内の間だけ true — 運行者タブの「確認中」はこれだけを見る。
 *
 * ## 失敗が現地で読めるようにする診断 (Refs ippoan/alc-app-s3#135)
 *
 * 本番で「この端末はまだ使える状態になっていません」の帯が消えないとき、**どの段で落ちたのか**が
 * 画面からもコンソールからも読めなかった。`lastError` (文字列) に加えて機械可読な
 * `lastFailureStage` (4 段) と `lastFailureStatus` (HTTP status)、抑止の期限 `coreS3BackoffUntil` を
 * 公開し、試行のたびにコンソールへ 1 行だけ出す。**挙動 (抑止の秒数・経路の優先順位) は変えない。**
 *
 * コンソールに出すのは「段 / HTTP status / サーバの error コード / 理由の語 / 経過 ms / 抑止の残り秒」
 * だけ。**token・nonce・署名・device_id・乗務員名は先頭数文字でも出さない** — 出す項目を
 * `warnCoreS3Failure()` で明示的に組み立て、応答オブジェクトはそのまま渡さない。
 *
 * ### 理由の語 (`lastFailureDetail`、続報 Refs ippoan/alc-app-s3#135)
 *
 * firmware は鍵が無ければ `ERR AUTH: no key`、nonce の形が不正なら `ERR AUTH: bad nonce` を
 * 即座に返す (`AUTH SIGN` の応答。`console.ts` 側)。この `ERR AUTH: ` に続く理由の語だけを
 * `coreS3-sign` 段の失敗から取り出して `lastFailureDetail` に残す — 画面側 (banner) が
 * 「鍵が無い」を他の失敗と出し分けられるようにするため。**署名・nonce・トークン・device_id は
 * 絶対に保持しない** (理由の語だけ)。firmware が想定外に長い文字列を返しても画面が壊れないよう
 * `MAX_FAILURE_DETAIL_LEN` で切り詰める。coreS3-sign 以外の段では null。
 */
import { ref, computed, readonly } from 'vue'
import { signAlarmDeviceNonce } from '~/composables/useDeviceLogin'

const KIOSK_DEVICE_ID_KEY = 'alc_kiosk_device_id'
const KIOSK_DEVICE_SECRET_KEY = 'alc_kiosk_device_secret'

/** device JWT 再利用の手前マージン (ms)。expiry ギリギリの token を返さない。 */
const REFRESH_BEFORE_MS = 60_000
/** expires_in 欠落時の fallback TTL (秒、auth-worker DEVICE_JWT_TTL_SECONDS と同値)。 */
const DEFAULT_TTL_SECONDS = 3600
/** CoreS3 署名 JWT の expires_in 欠落時 fallback TTL (秒。auth-worker #552 と同値) */
const CORE_S3_DEFAULT_TTL_SECONDS = 900
/** CoreS3 署名経路が失敗してから、これだけ試さない (ms)。再接続での解除は無い。 */
const CORE_S3_BACKOFF_MS = 60_000
/** lastFailureDetail に保持する理由の語の長さ上限 (#135 続報)。想定外の長い文字列で画面が壊れないように。 */
const MAX_FAILURE_DETAIL_LEN = 40
/**
 * 起動時の 1 本 (startupDeviceJwt) を「確認中」として待つ上限 (ms)。
 * useCoreS3Serial の claim 待ち (3 秒) と同じ起点・同じ長さ
 */
const STARTUP_TIMEOUT_MS = 3000

/**
 * CoreS3 署名経路がどの段で落ちたか (Refs ippoan/alc-app-s3#135)。
 * - `no-core-s3`: CoreS3 が USB でつながっていない (署名を頼む相手が居ない)
 * - `nonce`: auth-worker `/device/alarm-nonce` の取得
 * - `coreS3-sign`: CoreS3 への署名要求 (`AUTH SIGN`)
 * - `token-exchange`: auth-worker `/device/alarm-token` の交換
 */
export type DeviceTokenFailureStage = 'no-core-s3' | 'nonce' | 'coreS3-sign' | 'token-exchange'

const isClient = typeof window !== 'undefined'

const kioskDeviceId = ref<string | null>(
  isClient ? localStorage.getItem(KIOSK_DEVICE_ID_KEY) : null,
)
const kioskDeviceSecret = ref<string | null>(
  isClient ? localStorage.getItem(KIOSK_DEVICE_SECRET_KEY) : null,
)

// 短命 device JWT の cache (module スコープ = 全 caller で共有。CoreS3 署名経路も
// credential 経路も同じ cache に書く — 呼び出し側からは出どころの違いを見せない)。
// ref にしてあるのは hasDeviceJwt (#234-2、兄弟 #p135-c234-3 が使う) から参照できるようにするため。
const cachedJwt = ref<string | null>(null)
let cachedExpMs = 0

// getDeviceJwt() の single-flight。同時に何回呼ばれても実際の取得は 1 本にまとめる。
let jwtInFlight: Promise<string | null> | null = null
// CoreS3 署名経路の直近の失敗時刻から CORE_S3_BACKOFF_MS 経つまでは試さない (ms epoch)。
// 0 なら抑止していない。抑止の秒数も挙動も #135 では変えていない (診断で見えるようにしただけ)
const coreS3BackoffUntil = ref(0)
// CoreS3 署名経路の直近の失敗理由 (画面表示用)。成功 / 未試行なら null
const lastError = ref<string | null>(null)
// 直近の失敗がどの段か (#135)。成功 / 未試行なら null
const lastFailureStage = ref<DeviceTokenFailureStage | null>(null)
// 直近の失敗の HTTP status (#135)。HTTP を伴わない失敗 / 成功 / 未試行なら null
const lastFailureStatus = ref<number | null>(null)
// 直近の coreS3-sign 失敗の理由の語 (#135 続報。例: 'no key', 'bad nonce')。
// coreS3-sign 以外の段の失敗 / 成功 / 未試行なら null。**署名・nonce・トークン・device_id は含まない**
const lastFailureDetail = ref<string | null>(null)

const ERR_AUTH_PREFIX = 'ERR AUTH: '

/**
 * `coreS3-sign` 段の失敗理由から `ERR AUTH: ` に続く語だけを取り出す (#135 続報)。
 * firmware の応答行そのもの (署名や nonce を含みうる) ではなく、prefix が一致した場合の
 * 残り部分だけを扱う。長さは `MAX_FAILURE_DETAIL_LEN` で切り詰める (想定外の文字列対策)。
 * `coreS3-sign` 以外の段、または prefix が一致しない失敗は null (その他の理由として扱う)。
 */
function extractFailureDetail(stage: DeviceTokenFailureStage, message: string): string | null {
  if (stage !== 'coreS3-sign') return null
  if (!message.startsWith(ERR_AUTH_PREFIX)) return null
  const detail = message.slice(ERR_AUTH_PREFIX.length).trim()
  if (!detail) return null
  return detail.length > MAX_FAILURE_DETAIL_LEN ? detail.slice(0, MAX_FAILURE_DETAIL_LEN) : detail
}

/**
 * 失敗を 1 行だけコンソールに出す (#135)。**引数は呼び出し側が組み立てた scalar だけ**で、
 * 応答オブジェクト・token・nonce・署名は受け取らない (渡せないので漏れようがない)。
 */
function warnCoreS3Failure(
  stage: DeviceTokenFailureStage | 'backoff',
  status: number | null,
  code: string,
  detail: string | null,
  elapsedMs: number,
  backoffRemainSec: number,
): void {
  console.warn(
    `[useDeviceToken] 端末の署名に失敗 stage=${stage} status=${status ?? '-'} code=${code} detail=${detail ?? '-'} elapsed=${elapsedMs}ms backoff=${backoffRemainSec}s`,
  )
}

/**
 * 失敗応答の body から `error` の文字列だけを取り出す (#135 の診断用)。
 * 判定には一切使わない (経路の可否は従来どおり HTTP status だけで決める)。無ければ `'-'`。
 */
async function readErrorCode(res: { json: () => Promise<unknown> }): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown }
    return typeof data.error === 'string' ? data.error : '-'
  }
  catch {
    return '-'
  }
}
// CoreS3 の再接続監視 (キャッシュ破棄) を二重登録しないためのガード (useHubClaim と同じ流儀)
let closeListenerInstalled = false
// 起動時の 1 本 (= 最初の getDeviceJwt()、Refs #238)。起動から 1 回だけ作り、以後は同じものを返す
let startupJwtPromise: Promise<string | null> | null = null
// startupJwtPromise が未解決、かつ起動から STARTUP_TIMEOUT_MS 以内の間だけ true
const isStartupJwtPending = ref(false)

export function useDeviceToken() {
  const config = useRuntimeConfig()
  const authWorkerUrl = (config.public.authWorkerUrl as string) || 'https://auth.ippoan.org'
  // tenant 食い違いの warn 用 (#231)。読むだけ — 購読はしない
  const { deviceTenantId } = useAuth()

  const hasKioskCredential = computed(() => !!kioskDeviceId.value && !!kioskDeviceSecret.value)
  /** 期限内の device JWT を cache に持っているか (#234-2、兄弟 #p135-c234-3 が使う) */
  const hasDeviceJwt = computed(() => !!cachedJwt.value && cachedExpMs > Date.now())

  const coreS3 = useCoreS3Serial()
  // CoreS3 を抜線したら短命 JWT も即座に捨てる (親の決定)。useHubClaim と同じ
  // listenerInstalled 流儀で、useDeviceToken() を複数回呼んでも二重登録しない。
  if (!closeListenerInstalled) {
    closeListenerInstalled = true
    coreS3.onClose(() => {
      cachedJwt.value = null
      cachedExpMs = 0
    })
  }

  /** pairing で得た device credential を保存する (device JWT cache は破棄)。 */
  function storeKioskCredential(id: string, secret: string): void {
    kioskDeviceId.value = id
    kioskDeviceSecret.value = secret
    cachedJwt.value = null
    cachedExpMs = 0
    if (isClient) {
      localStorage.setItem(KIOSK_DEVICE_ID_KEY, id)
      localStorage.setItem(KIOSK_DEVICE_SECRET_KEY, secret)
    }
  }

  /** device credential と device JWT cache を破棄する (端末退役・revoke 後)。 */
  function clearKioskCredential(): void {
    kioskDeviceId.value = null
    kioskDeviceSecret.value = null
    cachedJwt.value = null
    cachedExpMs = 0
    if (isClient) {
      localStorage.removeItem(KIOSK_DEVICE_ID_KEY)
      localStorage.removeItem(KIOSK_DEVICE_SECRET_KEY)
    }
  }

  /**
   * device JWT を返す。優先順位は cache → CoreS3 の署名 (#234-2) →
   * 既存 credential (`/device/token`)。全経路失敗時は null (呼び出し側は X-Tenant-ID
   * 経路に fallback)。同時呼び出しは 1 本にまとめる (`jwtInFlight`)。
   */
  async function getDeviceJwt(): Promise<string | null> {
    const nowMs = Date.now()
    if (cachedJwt.value && cachedExpMs - REFRESH_BEFORE_MS > nowMs) return cachedJwt.value

    if (!jwtInFlight) {
      jwtInFlight = mintDeviceJwt().finally(() => { jwtInFlight = null })
    }
    return jwtInFlight
  }

  /**
   * 起動時の 1 本。初回の呼び出しで getDeviceJwt() を始める (中で CoreS3 の探索を最大 3 秒待ち、
   * 繋がっていれば署名で取る)。2 回目以降は同じ promise を返す — 途中の getDeviceJwt() も
   * single-flight で同じ取得に合流する。`isStartupJwtPending` は「1 本の解決」か
   * 「起動から STARTUP_TIMEOUT_MS」の早い方で下りる (fetch に timeout が無いので上限を外さない)。
   * WebSerial 非対応なら null で何もしない (最初から確認中にしない)
   */
  function startupDeviceJwt(): Promise<string | null> {
    if (!coreS3.isSupported) return Promise.resolve(null)
    if (!startupJwtPromise) {
      startupJwtPromise = getDeviceJwt()
      isStartupJwtPending.value = true
      const deadline = new Promise<void>(resolve => setTimeout(resolve, STARTUP_TIMEOUT_MS))
      void Promise.race([startupJwtPromise, deadline]).finally(() => { isStartupJwtPending.value = false })
    }
    return startupJwtPromise
  }

  /** cache 以外の 2 経路を順に試す (CoreS3 の署名 → credential)。 */
  async function mintDeviceJwt(): Promise<string | null> {
    const nowMs = Date.now()
    return (await tryCoreS3Jwt(nowMs)) ?? (await tryCredentialJwt(nowMs))
  }

  /**
   * CoreS3 が USB で繋がっていれば、その ed25519 鍵の署名で auth-worker
   * (#552) から短命 JWT を取りに行く。未接続なら起動時の探索 (`startupProbe`、
   * 起動から最大 3 秒で 1 回だけ) を待ち、それでも未接続なら null (以後は待たずに即 null)。
   * 抑止期間中 / いずれかの失敗
   * (401 `{error:"invalid_alarm_token"}` / 429 / タイムアウト / 通信エラー、
   * いずれも HTTP status だけで判定する) なら null を返し、CORE_S3_BACKOFF_MS の
   * 間この経路を抑止する (再接続での解除はしない)。失敗理由は `lastError` に残し、
   * 成功したら null に戻す。
   */
  async function tryCoreS3Jwt(nowMs: number): Promise<string | null> {
    if (nowMs < coreS3BackoffUntil.value) {
      // 抑止中は試さない (従来どおり)。空振りした事実と残り秒だけ出す —
      // 直近の失敗の段・理由の語 (lastFailureStage / lastFailureDetail) は次の試行まで保持する
      warnCoreS3Failure('backoff', lastFailureStatus.value, '-', lastFailureDetail.value, 0, Math.ceil((coreS3BackoffUntil.value - nowMs) / 1000))
      return null
    }
    if (!coreS3.isConnected.value) {
      // 結果の真偽ではなく接続を見直す — 探索で繋がった後に抜かれていれば署名は頼めない
      await coreS3.startupProbe()
      if (!coreS3.isConnected.value) {
        // 署名を頼む相手が居ない。抑止も lastError も立てない (従来どおり) が、段だけは残す
        lastFailureStage.value = 'no-core-s3'
        lastFailureStatus.value = null
        lastFailureDetail.value = null
        warnCoreS3Failure('no-core-s3', null, '-', null, Date.now() - nowMs, 0)
        return null
      }
    }

    lastError.value = null
    lastFailureStage.value = null
    lastFailureStatus.value = null
    lastFailureDetail.value = null
    // どの段まで進んだか (#135)。throw した時点の値がそのまま失敗の段になる
    let stage: DeviceTokenFailureStage = 'nonce'
    let status: number | null = null
    let code = '-'
    try {
      const nonceRes = await fetch(`${authWorkerUrl}/device/alarm-nonce`)
      if (!nonceRes.ok) {
        status = nonceRes.status
        code = await readErrorCode(nonceRes)
        throw new Error(`alarm-nonce http ${nonceRes.status}`)
      }
      const nonceData = (await nonceRes.json()) as { nonce?: string }
      if (!nonceData.nonce) throw new Error('alarm-nonce: nonce 欠落')

      stage = 'coreS3-sign'
      const signed = await signAlarmDeviceNonce(nonceData.nonce, coreS3.request)
      if (!signed) throw new Error('AUTH SIG の parse に失敗')

      stage = 'token-exchange'
      const tokenRes = await fetch(`${authWorkerUrl}/device/alarm-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: nonceData.nonce, pubkey: signed.pubkey, sig: signed.sig }),
      })
      if (!tokenRes.ok) {
        status = tokenRes.status
        code = await readErrorCode(tokenRes)
        throw new Error(`alarm-token http ${tokenRes.status}`)
      }
      const tokenData = (await tokenRes.json()) as {
        access_token?: string
        token_type?: string
        expires_in?: number
        tenant_id?: string
      }
      if (!tokenData.access_token) throw new Error('alarm-token: access_token 欠落')

      // tenant の食い違いは拒否しない (発行元 auth-worker の判断を尊重)。
      // **出し分けるのは、2 つがまったく別の事象だから** (冒頭 doc の #552 の項)。
      // 未設定を warn にすると常時鳴り、**下の本物の異常を隠す**
      const issuedTenantId = tokenData.tenant_id
      const registeredTenantId = deviceTenantId.value
      if (typeof issuedTenantId === 'string' && issuedTenantId !== registeredTenantId) {
        if (registeredTenantId) {
          console.warn(
            `[useDeviceToken] 端末の登録先と発行元が食い違っています — この端末は tenant ${registeredTenantId} に登録されていますが、alarm-token は tenant ${issuedTenantId} で発行されました (拒否はしません)`,
          )
        }
        else {
          // 平常運転。CoreS3 に紐づく共用 PC はブラウザ側の端末登録を通らない
          console.debug(
            `[useDeviceToken] ブラウザ側の端末登録なしで alarm-token を受けました (tenant ${issuedTenantId})`,
          )
        }
      }

      const ttl = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : CORE_S3_DEFAULT_TTL_SECONDS
      cachedJwt.value = tokenData.access_token
      cachedExpMs = nowMs + ttl * 1000
      console.info(`[useDeviceToken] 端末の署名に成功 stage=ok elapsed=${Date.now() - nowMs}ms`)
      return cachedJwt.value
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      lastFailureStage.value = stage
      lastFailureStatus.value = status
      lastFailureDetail.value = extractFailureDetail(stage, lastError.value)
      coreS3BackoffUntil.value = nowMs + CORE_S3_BACKOFF_MS
      warnCoreS3Failure(stage, status, code, lastFailureDetail.value, Date.now() - nowMs, CORE_S3_BACKOFF_MS / 1000)
      return null
    }
  }

  /** 既存の credential 経路 (`/device/token`)。挙動は変えない。 */
  async function tryCredentialJwt(nowMs: number): Promise<string | null> {
    const id = kioskDeviceId.value
    const secret = kioskDeviceSecret.value
    if (!id || !secret) return null

    try {
      const res = await fetch(`${authWorkerUrl}/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id, device_secret: secret }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { access_token?: string; expires_in?: number }
      if (!data.access_token) return null
      const ttl = typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_TTL_SECONDS
      cachedJwt.value = data.access_token
      cachedExpMs = nowMs + ttl * 1000
      return cachedJwt.value
    } catch {
      return null
    }
  }

  /**
   * 管理者 (operator session) が auth-worker `/device/pair` で device-kiosk
   * credential を発行する (P1 pairing の管理者側)。返り値の credential を QR 等で
   * kiosk に渡し、kiosk 側で `storeKioskCredential` する想定。device_secret は
   * 1 回限り (auth-worker は hash のみ保持) なので呼び出し側で即配布する。
   *
   * @param adminToken 管理者の access token (rust-alc-api / auth-worker 共有 JWT_SECRET)
   * @param label      運用識別ラベル (端末名等)
   * @returns 失敗時は null
   */
  async function pairKioskDevice(
    adminToken: string,
    label: string,
  ): Promise<{ device_id: string; device_secret: string } | null> {
    if (!adminToken) return null
    try {
      const res = await fetch(`${authWorkerUrl}/device/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ label, role: 'device-kiosk' }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { device_id?: string; device_secret?: string }
      if (!data.device_id || !data.device_secret) return null
      return { device_id: data.device_id, device_secret: data.device_secret }
    } catch {
      return null
    }
  }

  /**
   * この端末をキオスク化する (P1 / 方式1)。管理者がログイン済みの端末で 1 度だけ実行する。
   * 現在の access token で `/device/pair` を叩いて device-kiosk credential を発行し、
   * そのまま端末に保存する (self-pair)。以降この端末は (管理者ログアウト後) device JWT
   * 経由で通信する。通常の管理者セッションは self-pair しないので分離は保たれる。
   *
   * @returns 成功時 true (credential 発行・保存済み)、失敗時 false
   */
  async function setupAsKiosk(adminToken: string, label: string): Promise<boolean> {
    const cred = await pairKioskDevice(adminToken, label)
    if (!cred) return false
    storeKioskCredential(cred.device_id, cred.device_secret)
    return true
  }

  return {
    hasKioskCredential,
    hasDeviceJwt,
    kioskDeviceId: readonly(kioskDeviceId),
    storeKioskCredential,
    clearKioskCredential,
    getDeviceJwt,
    startupDeviceJwt,
    /** 起動時の 1 本 (startupDeviceJwt) が未解決かつ起動から 3 秒以内の間だけ true */
    isStartupJwtPending: readonly(isStartupJwtPending),
    pairKioskDevice,
    setupAsKiosk,
    /** CoreS3 署名経路の直近の失敗理由。成功 / 未試行なら null */
    lastError: readonly(lastError),
    /** 直近の失敗がどの段で起きたか (#135)。成功 / 未試行なら null */
    lastFailureStage: readonly(lastFailureStage),
    /** 直近の失敗の HTTP status (#135)。HTTP を伴わない失敗 / 成功 / 未試行なら null */
    lastFailureStatus: readonly(lastFailureStatus),
    /** 直近の coreS3-sign 失敗の理由の語 (#135 続報。例: 'no key')。それ以外の段 / 成功 / 未試行なら null */
    lastFailureDetail: readonly(lastFailureDetail),
    /** CoreS3 署名経路を抑止している期限 (ms epoch)。0 なら抑止していない (#135) */
    coreS3BackoffUntil: readonly(coreS3BackoffUntil),
  }
}
