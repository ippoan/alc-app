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
 * - 署名の取り方は 2 段構え (#322-2、Refs ippoan/alc-app-s3#249)。まず
 *   `AUTH SIGNBP <nonce>` → `AUTH SIGBP <pubkey> <sig> BP=1` /
 *   `AUTH SIGBP <pubkey> <sig> BP=0` (血圧計がボンド済みなら `BP=1`、未ボンドなら
 *   `BP=0`。CoreS3 ファーム側の既存応答 `OMRON BP=0` / `STATUS LAN=1` に綴りを揃えた形。
 *   `<sig>` は署名対象の小文字 `<nonce>|bp=1` / `<nonce>|bp=0` に対するもので、
 *   応答行の大文字 `BP=` とは別物 — ブラウザは検証も構築もせず parse するだけ) を試す
 *   (`signKioskNonce` がこのモジュールに閉じて持つ — 管理者ログインと共有する
 *   `AUTH SIGN` とは別コマンドの独立した経路)。
 *   古いファーム (`SIGNBP` 未対応) は未知コマンドとして reject するので、その場合は
 *   **今までどおり** `AUTH SIGN <nonce>` → `AUTH SIG <pubkey> <sig>` parse
 *   (`utils/alarm-sign.ts` の共有署名関数、#214 と同じ firmware I/F。
 *   送り先は `useCoreS3Serial().request` を渡す) にフォールバックし、この場合は
 *   ボンド状態が「不明」であって「未ボンド」ではない — `/device/alarm-token` に
 *   `bp_bonded` を送らない (`SIGNBP` が成功した場合だけ送る)。ボンド状態は CoreS3 の
 *   署名対象に含まれる値をそのまま素通しするだけで、ブラウザ側では作らない・書き換えない。
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
 * `MAX_FAILURE_DETAIL_LEN` で切り詰める。署名の段 (coreS3-sign / vein-sign) 以外では null。
 *
 * ## Vein Station の鍵 (Refs ippoan/alc-app#436)
 *
 * Vein Station (指静脈読み取り端末、`DEVICE timecard`) が USB で繋がっていれば、**その鍵だけ**で
 * 署名する (ユーザー決定)。順は「cache → Vein Station 署名 (繋がっていれば、これだけ) →
 * CoreS3 署名 → credential」。CoreS3 と同じ 1 本の関数 (`trySignerJwt`) を、署名の相手
 * (`KioskSigner`) を差し替えて呼ぶ。
 *
 * - 繋がっているのに取れなかった (未登録 401/403・`ERR AUTH: no key`・タイムアウト) ときは
 *   **CoreS3・credential・無認証のどれにも落とさない** — 別の鍵で黙って本番に記録しないため。
 *   無認証への落ち方は `api.ts` が `isKioskDeviceKeyRequired()` を見て止める。
 *   段は `vein-sign` (署名) / `nonce` / `token-exchange` で、帯 (DeviceUnregisteredBanner) に出る
 * - 署名は `AUTH SIGN` だけを使う (`SIGNBP` は送らない)。Vein Station の `BP=0` は
 *   「血圧計なしと確認済み」ではないので、`bp_bonded` を送らず、ボンド状態 (`setSignedBpBond`) にも
 *   書かない
 * - 抑止 (backoff) は署名の相手ごとに別 (`veinBackoffUntil`)。指静脈の読み取りと重なって
 *   arbiter が「既に応答待ちです」で断った回は一時的な失敗として抑止しない (次の呼び出しで再試行)
 * - 抜線 (`useVeinSerial().onClose`) で Vein Station 由来のキャッシュを捨てる。storage には書かない
 */
import { ref, computed, readonly, watch } from 'vue'
import type { Ref } from 'vue'
import { signAlarmDeviceNonce } from '~/utils/alarm-sign'
import { withTimeout, AUTH_WORKER_FETCH_TIMEOUT_MS } from '~/utils/fetch-timeout'
import { noteDeviceToken, setKioskDeviceKeyRequired } from '~/utils/token-selection'

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
 * - `vein-sign`: Vein Station への署名要求 (`AUTH SIGN`、Refs ippoan/alc-app#436)
 * - `token-exchange`: auth-worker `/device/alarm-token` の交換
 */
export type DeviceTokenFailureStage = 'no-core-s3' | 'nonce' | 'coreS3-sign' | 'vein-sign' | 'token-exchange'

/** 署名の相手 (Refs ippoan/alc-app#436)。CoreS3 と Vein Station で同じ `trySignerJwt` を使う */
interface KioskSigner {
  /** どの相手か (キャッシュの出どころ・直近の失敗の相手) */
  source: 'coreS3' | 'vein'
  /** 署名の段の名前 (診断用) */
  signStage: 'coreS3-sign' | 'vein-sign'
  /** この相手の抑止期限 (ms epoch)。相手ごとに別に持つ */
  backoffUntil: Ref<number>
  /** 署名を頼める状態か (未接続なら探索まで含めて確かめる)。false なら trySignerJwt は null */
  ensureConnected: (nowMs: number) => Promise<boolean>
  /** nonce に署名する。parse に失敗したら null、firmware の ERR は reject */
  sign: (nonce: string) => Promise<{ pubkey: string, sig: string, bpBonded?: boolean } | null>
  /** 血圧計のボンド状態 (setSignedBpBond) を書くか。CoreS3 だけ */
  writesBpBond: boolean
}

/** キャッシュ中の JWT の出どころ。Vein Station 接続中は Vein 由来のものしか使わない (#436) */
type JwtSource = 'coreS3' | 'vein' | 'credential'

/** arbiter が同時 2 件目を断ったときの文言 (useSerialArbiter.request)。一時的な失敗として扱う */
const SERIAL_BUSY_MARK = '既に応答待ちです'

/** キオスク用ボンド状態つき署名 (`AUTH SIGNBP`) の parse 結果 (#322-2)。 */
interface KioskBondedSignature {
  pubkey: string
  sig: string
  /** 血圧計がボンド済みか。`AUTH SIGNBP` が成功したときだけ得られる。 */
  bpBonded: boolean
}

/** `AUTH SIGN` 系コマンドと同じ 10 秒 (utils/alarm-sign.ts の AUTH_SIGN_TIMEOUT_MS と同値)。 */
const AUTH_SIGNBP_TIMEOUT_MS = 10_000
const AUTH_SIGNBP_MATCH_PREFIX = 'AUTH SIGBP '

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
let cachedSource: JwtSource | null = null
// このトークンが dev端末のものかを、送るトークンの選択 (`~/utils/token-selection`) が**同期で**
// 読めるようにする (Refs ippoan/alc-app#387)。cache の書き換え・破棄のすべてに追従する。
// 取得の経路・タイミングは変えない (見ているだけ)
watch(cachedJwt, token => noteDeviceToken('kiosk', token), { flush: 'sync' })

// getDeviceJwt() の single-flight。同時に何回呼ばれても実際の取得は 1 本にまとめる。
let jwtInFlight: Promise<string | null> | null = null
// CoreS3 署名経路の直近の失敗時刻から CORE_S3_BACKOFF_MS 経つまでは試さない (ms epoch)。
// 0 なら抑止していない。抑止の秒数も挙動も #135 では変えていない (診断で見えるようにしただけ)
const coreS3BackoffUntil = ref(0)
// Vein Station 署名経路の抑止期限 (#436)。CoreS3 とは別に持つ
const veinBackoffUntil = ref(0)
// 直近の失敗がどちらの署名の相手か (#436)。帯の「あと N 秒」がどちらの抑止を見るかを決める
const lastFailureSigner = ref<'coreS3' | 'vein' | null>(null)
// CoreS3 署名経路の直近の失敗理由 (画面表示用)。成功 / 未試行なら null
const lastError = ref<string | null>(null)
// 直近の失敗がどの段か (#135)。成功 / 未試行なら null
const lastFailureStage = ref<DeviceTokenFailureStage | null>(null)
// 直近の失敗の HTTP status (#135)。HTTP を伴わない失敗 / 成功 / 未試行なら null
const lastFailureStatus = ref<number | null>(null)
// 直近の署名の段 (coreS3-sign / vein-sign) の失敗の理由の語 (#135 続報。例: 'no key', 'bad nonce')。
// 署名以外の段の失敗 / 成功 / 未試行なら null。**署名・nonce・トークン・device_id は含まない**
const lastFailureDetail = ref<string | null>(null)

/**
 * 血圧計のボンド状態は **`useSignedBpBond.ts` が持つ 1 か所** に移した
 * (Refs ippoan/alc-app#353)。ここは CoreS3 経路の**書き手**として
 * `setSignedBpBond()` を呼ぶだけで、値は持たない —
 * ATOM S3 (血圧測定台) 経路も同じ 1 か所へ書き込めるようにするため。
 */

const ERR_AUTH_PREFIX = 'ERR AUTH: '

/**
 * `coreS3-sign` 段の失敗理由から `ERR AUTH: ` に続く語だけを取り出す (#135 続報)。
 * firmware の応答行そのもの (署名や nonce を含みうる) ではなく、prefix が一致した場合の
 * 残り部分だけを扱う。長さは `MAX_FAILURE_DETAIL_LEN` で切り詰める (想定外の文字列対策)。
 * 署名の段 (`coreS3-sign` / `vein-sign`) 以外、または prefix が一致しない失敗は null (その他の理由として扱う)。
 */
function extractFailureDetail(stage: DeviceTokenFailureStage, message: string): string | null {
  if (stage !== 'coreS3-sign' && stage !== 'vein-sign') return null
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

/**
 * `AUTH SIGBP <pubkey> <sig> BP=1` / `AUTH SIGBP <pubkey> <sig> BP=0` を space で
 * 分割して parse (#322-2、親の確定指示で `<bp>` から `BP=<bp>` へ変更 — CoreS3
 * ファーム側の既存応答 `OMRON BP=0` / `STATUS LAN=1` に綴りを揃えるため)。4 語目は
 * 大文字の `BP=1` / `BP=0` のみを受け付ける (署名対象の小文字 `bp=` とは別物)。
 * 形式が合わなければ null (呼び出し側は `AUTH SIGN` へフォールバックする —
 * parseAuthSigLine と同じ流儀)。
 */
function parseAuthSigBpLine(line: string): KioskBondedSignature | null {
  const parts = line.split(' ')
  if (parts.length !== 5 || parts[0] !== 'AUTH' || parts[1] !== 'SIGBP') return null
  const bp = parts[4]
  if (bp !== 'BP=0' && bp !== 'BP=1') return null
  return { pubkey: parts[2]!, sig: parts[3]!, bpBonded: bp === 'BP=1' }
}

/**
 * `AUTH SIGNBP <nonce>` を送り、応答 `AUTH SIGBP <pubkey> <sig> <bp>` を parse する
 * (#322-2)。旧管理者ログイン (#353-8 で廃止) と共有していた署名関数 (utils/alarm-sign.ts) とは
 * 別コマンドの独立した経路 — このモジュールに閉じる (キオスク専用)。firmware が
 * `SIGNBP` を未知コマンドとして `ERR AUTH: ...` を返せば request がそのまま reject する
 * ので、ここでは投げっぱなしにする (呼び出し側の signKioskNonce でフォールバックする)。
 * parse に失敗したときだけ null を返す。
 */
async function signKioskBondedNonce(
  nonce: string,
  request: (line: string, matchPrefix: string, timeoutMs: number) => Promise<string>,
): Promise<KioskBondedSignature | null> {
  const line = await request(`AUTH SIGNBP ${nonce}`, AUTH_SIGNBP_MATCH_PREFIX, AUTH_SIGNBP_TIMEOUT_MS)
  return parseAuthSigBpLine(line)
}

/**
 * キオスク用の署名取得 (#322-2)。まずボンド状態つき `AUTH SIGNBP` を試し、古いファーム
 * (未知コマンドとして reject) や parse 失敗なら**今までどおり** `AUTH SIGN`
 * (utils/alarm-sign.ts の共有署名関数) に
 * フォールバックする。フォールバック時は `bpBonded` を持たない (= ボンド状態は「不明」)。
 * `AUTH SIGN` 側の失敗 (no key 等) はここでは捕まえず、そのまま呼び出し側 (trySignerJwt) へ
 * 伝える — 診断 (#135 lastFailureDetail 等) の挙動を変えないため。
 */
async function signKioskNonce(
  nonce: string,
  request: (line: string, matchPrefix: string, timeoutMs: number) => Promise<string>,
): Promise<{ pubkey: string, sig: string, bpBonded?: boolean } | null> {
  try {
    const bonded = await signKioskBondedNonce(nonce, request)
    if (bonded) return bonded
  }
  catch {
    // AUTH SIGNBP 未対応の古いファーム (未知コマンドとして ERR AUTH) はここで飲み込み、
    // 下の AUTH SIGN フォールバックへ進む (古いファームの端末を締め出さない)。
  }
  return signAlarmDeviceNonce(nonce, request)
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
  const vein = useVeinSerial()
  // CoreS3 を抜線したら短命 JWT も即座に捨てる (親の決定)。useHubClaim と同じ
  // listenerInstalled 流儀で、useDeviceToken() を複数回呼んでも二重登録しない。
  if (!closeListenerInstalled) {
    closeListenerInstalled = true
    coreS3.onClose(() => {
      cachedJwt.value = null
      cachedExpMs = 0
    })
    // Vein Station を抜線したら、その鍵で取った JWT も即座に捨てる (#436)
    vein.onClose(() => {
      if (cachedSource !== 'vein') return
      cachedJwt.value = null
      cachedExpMs = 0
    })
    // 繋がっている間は、キオスクの鍵が取れない送信を無認証へ落とさない (api.ts が同期で読む)
    watch(vein.isConnected, connected => setKioskDeviceKeyRequired(connected), { immediate: true, flush: 'sync' })
    // 挿されたら抑止を解いてすぐ鍵を読む (useBpStationDeviceToken の ATOM の onOpen と同じ形) —
    // 開発用の印を、送信を待たずに鍵で決めるため。取れなければ今までどおり送信時に取り直す
    watch(vein.isConnected, (connected) => {
      if (!connected) return
      veinBackoffUntil.value = 0
      void getDeviceJwt()
    }, { flush: 'sync' })
  }

  /** CoreS3 (統合ハブ)。署名は SIGNBP → SIGN の 2 段構えで、ボンド状態も書く */
  const coreS3Signer: KioskSigner = {
    source: 'coreS3',
    signStage: 'coreS3-sign',
    backoffUntil: coreS3BackoffUntil,
    async ensureConnected(nowMs) {
      if (coreS3.isConnected.value) return true
      // 結果の真偽ではなく接続を見直す — 探索で繋がった後に抜かれていれば署名は頼めない
      await coreS3.startupProbe()
      if (coreS3.isConnected.value) return true
      // 署名を頼む相手が居ない。抑止も lastError も立てない (従来どおり) が、段だけは残す
      lastFailureStage.value = 'no-core-s3'
      lastFailureStatus.value = null
      lastFailureDetail.value = null
      // 署名を頼む相手が居ない = ボンド状態は「不明」(「未ボンド」ではない)。
      // 探索まではしたので「試した」= 判定してよい (#336)
      setSignedBpBond(null)
      warnCoreS3Failure('no-core-s3', null, '-', null, Date.now() - nowMs, 0)
      return false
    },
    sign: nonce => signKioskNonce(nonce, coreS3.request),
    writesBpBond: true,
  }

  /**
   * Vein Station (#436)。mintDeviceJwt が接続中のときだけ呼ぶので探索はしない。
   * 署名は `AUTH SIGN` だけ (SIGNBP の BP=0 は「血圧計なし」の確認ではないため送らない)
   */
  const veinSigner: KioskSigner = {
    source: 'vein',
    signStage: 'vein-sign',
    backoffUntil: veinBackoffUntil,
    ensureConnected: async () => vein.isConnected.value,
    sign: nonce => signAlarmDeviceNonce(nonce, vein.request),
    writesBpBond: false,
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
    // Vein Station 接続中は、その鍵で取った JWT 以外を使わない (#436。接続前に CoreS3 等で取った分は捨て置く)
    const usable = !vein.isConnected.value || cachedSource === 'vein'
    if (cachedJwt.value && usable && cachedExpMs - REFRESH_BEFORE_MS > nowMs) return cachedJwt.value

    if (!jwtInFlight) {
      jwtInFlight = mintDeviceJwt().finally(() => { jwtInFlight = null })
    }
    return jwtInFlight
  }

  /**
   * 起動時の 1 本。初回の呼び出しで getDeviceJwt() を始める (中で CoreS3 の探索を最大 3 秒待ち、
   * 繋がっていれば署名で取る)。2 回目以降は同じ promise を返す — 途中の getDeviceJwt() も
   * single-flight で同じ取得に合流する。`isStartupJwtPending` は「1 本の解決」か
   * 「起動から STARTUP_TIMEOUT_MS」の早い方で下りる (fetch 自体にも上限が入ったが、
   * CoreS3 の探索を含む 1 本は 3 秒より長くなり得るのでこの上限は残す)。
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

  /**
   * cache 以外の経路を順に試す。Vein Station が繋がっていれば**その署名だけ** (#436、
   * 失敗しても他へ落とさない)。繋がっていなければ CoreS3 の署名 → credential。
   */
  async function mintDeviceJwt(): Promise<string | null> {
    const nowMs = Date.now()
    if (vein.isConnected.value) return await trySignerJwt(veinSigner, nowMs)
    return (await trySignerJwt(coreS3Signer, nowMs)) ?? (await tryCredentialJwt(nowMs))
  }

  /**
   * 署名の相手 (CoreS3 / Vein Station) が繋がっていれば、その ed25519 鍵の署名で auth-worker
   * (#552) から短命 JWT を取りに行く。CoreS3 が未接続なら起動時の探索 (`startupProbe`、
   * 起動から最大 3 秒で 1 回だけ) を待ち、それでも未接続なら null (以後は待たずに即 null)。
   * 抑止期間中 / いずれかの失敗
   * (401 `{error:"invalid_alarm_token"}` / 429 / タイムアウト / 通信エラー、
   * いずれも HTTP status だけで判定する) なら null を返し、CORE_S3_BACKOFF_MS の
   * 間その相手の経路を抑止する (再接続での解除はしない)。ただしシリアルが別の応答待ちで
   * 断られた回は一時的なので抑止しない (#436)。失敗理由は `lastError` に残し、
   * 成功したら null に戻す。
   */
  async function trySignerJwt(signer: KioskSigner, nowMs: number): Promise<string | null> {
    if (nowMs < signer.backoffUntil.value) {
      // 抑止中は試さない (従来どおり)。空振りした事実と残り秒だけ出す —
      // 直近の失敗の段・理由の語 (lastFailureStage / lastFailureDetail) は次の試行まで保持する
      warnCoreS3Failure('backoff', lastFailureStatus.value, '-', lastFailureDetail.value, 0, Math.ceil((signer.backoffUntil.value - nowMs) / 1000))
      return null
    }
    if (!(await signer.ensureConnected(nowMs))) return null

    lastError.value = null
    lastFailureStage.value = null
    lastFailureStatus.value = null
    lastFailureDetail.value = null
    // どの段まで進んだか (#135)。throw した時点の値がそのまま失敗の段になる
    let stage: DeviceTokenFailureStage = 'nonce'
    let status: number | null = null
    let code = '-'
    try {
      const nonceRes = await fetch(`${authWorkerUrl}/device/alarm-nonce`, withTimeout({}, AUTH_WORKER_FETCH_TIMEOUT_MS))
      if (!nonceRes.ok) {
        status = nonceRes.status
        code = await readErrorCode(nonceRes)
        throw new Error(`alarm-nonce http ${nonceRes.status}`)
      }
      const nonceData = (await nonceRes.json()) as { nonce?: string }
      if (!nonceData.nonce) throw new Error('alarm-nonce: nonce 欠落')

      stage = signer.signStage
      const signed = await signer.sign(nonceData.nonce)
      if (!signed) throw new Error('AUTH SIG の parse に失敗')

      stage = 'token-exchange'
      const tokenRes = await fetch(`${authWorkerUrl}/device/alarm-token`, withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce: nonceData.nonce,
          pubkey: signed.pubkey,
          sig: signed.sig,
          // AUTH SIGNBP が成功したときだけ送る (#322-2)。フォールバック (AUTH SIGN) 時は
          // ボンド状態が「不明」であって「未ボンド」ではないため、フィールド自体を省く
          // (auth-worker 側は欠落を「不明」として扱う)。
          ...(signed.bpBonded !== undefined ? { bp_bonded: signed.bpBonded } : {}),
        }),
      }, AUTH_WORKER_FETCH_TIMEOUT_MS))
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
      cachedSource = signer.source
      cachedJwt.value = tokenData.access_token
      cachedExpMs = nowMs + ttl * 1000
      // いま発行された JWT に乗っているボンド状態 (#336)。`AUTH SIGN` へ落ちた回は
      // `bpBonded` を持たない = 「不明」なので null にする。Vein Station は書かない (#436)
      if (signer.writesBpBond) setSignedBpBond(signed.bpBonded ?? null)
      console.info(`[useDeviceToken] 端末の署名に成功 stage=ok elapsed=${Date.now() - nowMs}ms`)
      return cachedJwt.value
    }
    catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e)
      lastFailureStage.value = stage
      lastFailureStatus.value = status
      lastFailureDetail.value = extractFailureDetail(stage, lastError.value)
      lastFailureSigner.value = signer.source
      // 署名が JWT まで届かなかった回は、サーバにボンド状態が渡っていない = 「不明」(#336)
      if (signer.writesBpBond) setSignedBpBond(null)
      // シリアルが別の応答待ち (指静脈の読み取り中など)・ファームの書き込み中 (錠) で断られた回は
      // 一時的 — 抑止しない (#436。更新の直後に署名が 60 秒止まらないように)。
      // `OTA_LOCKED_MESSAGE` は auto-import のまま使う (明示 import は useAlarmDevice を mock する試験の読み込み順を崩す)
      const busy = lastError.value.includes(SERIAL_BUSY_MARK) || lastError.value.includes(OTA_LOCKED_MESSAGE)
      if (!busy) signer.backoffUntil.value = nowMs + CORE_S3_BACKOFF_MS
      warnCoreS3Failure(stage, status, code, lastFailureDetail.value, Date.now() - nowMs, busy ? 0 : CORE_S3_BACKOFF_MS / 1000)
      return null
    }
  }

  /**
   * ボンド状態を取り直す (Refs ippoan/alc-app#336)。「不明」は**その端末が永久に駄目**
   * という意味ではなく、CoreS3 がその瞬間つながっていなかっただけのことがある。
   * だから画面の「もう一度試す」からここを呼べるようにし、抑止 (backoff) を解いて
   * **CoreS3 の再探索から**署名をやり直す。
   *
   * `getDeviceJwt()` ではなく CoreS3 の `trySignerJwt()` を直に呼ぶ — cache が生きていると
   * `getDeviceJwt()` は署名をやり直さず、ボンド状態が「不明」のまま戻らないため。
   * credential 経路には触れない (CoreS3 が居なければ従来どおり何も変わらない)。
   */
  async function refreshSignedBpBonded(): Promise<boolean | null> {
    const { signedBpBonded } = useSignedBpBond()
    coreS3BackoffUntil.value = 0
    await trySignerJwt(coreS3Signer, Date.now())
    return signedBpBonded.value
  }

  /** 既存の credential 経路 (`/device/token`)。挙動は変えない。 */
  async function tryCredentialJwt(nowMs: number): Promise<string | null> {
    const id = kioskDeviceId.value
    const secret = kioskDeviceSecret.value
    if (!id || !secret) return null

    try {
      const res = await fetch(`${authWorkerUrl}/device/token`, withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: id, device_secret: secret }),
      }, AUTH_WORKER_FETCH_TIMEOUT_MS))
      if (!res.ok) return null
      const data = (await res.json()) as { access_token?: string; expires_in?: number }
      if (!data.access_token) return null
      const ttl = typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_TTL_SECONDS
      cachedSource = 'credential'
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
   * @param opts.devDevice true のときだけ body に `dev_device: true` を入れ、開発用の鍵を作る
   *   (Refs ippoan/alc-app#387)。auth-worker は欄があるだけで開発者の Google ログインを要求する
   *   (false でも 403) ので、false / 省略では欄ごと載せない
   * @returns 失敗時は null。`devDevice` を付けて 403 だったときは `'dev_forbidden'`
   */
  async function pairKioskDevice(
    adminToken: string,
    label: string,
    opts?: { devDevice?: boolean },
  ): Promise<{ device_id: string; device_secret: string } | 'dev_forbidden' | null> {
    if (!adminToken) return null
    const devDevice = opts?.devDevice === true
    try {
      const res = await fetch(`${authWorkerUrl}/device/pair`, withTimeout({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify(devDevice
          ? { label, role: 'device-kiosk', dev_device: true }
          : { label, role: 'device-kiosk' }),
      }, AUTH_WORKER_FETCH_TIMEOUT_MS))
      if (devDevice && res.status === 403) return 'dev_forbidden'
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
   * @param opts.devDevice true なら開発用の鍵を作る ({@link pairKioskDevice} と同じ)
   * @returns 成功時 true (credential 発行・保存済み)、失敗時 false。
   *   `devDevice` を付けて開発用を断られたときは `'dev_forbidden'`
   */
  async function setupAsKiosk(
    adminToken: string,
    label: string,
    opts?: { devDevice?: boolean },
  ): Promise<boolean | 'dev_forbidden'> {
    const cred = await pairKioskDevice(adminToken, label, opts)
    if (cred === 'dev_forbidden') return cred
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
    /** 直近の署名の段 (coreS3-sign / vein-sign) の失敗の理由の語 (#135 続報。例: 'no key')。それ以外の段 / 成功 / 未試行なら null */
    lastFailureDetail: readonly(lastFailureDetail),
    /** CoreS3 署名経路を抑止している期限 (ms epoch)。0 なら抑止していない (#135) */
    coreS3BackoffUntil: readonly(coreS3BackoffUntil),
    /**
     * 直近の失敗の相手 (CoreS3 / Vein Station) の抑止期限 (ms epoch、#436)。帯の「あと N 秒」用。
     * 失敗がまだ無ければ CoreS3 の値
     */
    failureBackoffUntil: computed(() => (lastFailureSigner.value === 'vein' ? veinBackoffUntil.value : coreS3BackoffUntil.value)),
    /**
     * ボンド状態を取り直す (#336)。抑止を解き、CoreS3 の再探索から署名をやり直す。
     * **値そのものは返さない** — 読むのは `useSignedBpBond()` の 1 か所だけ (#353)。
     */
    refreshSignedBpBonded,
  }
}
