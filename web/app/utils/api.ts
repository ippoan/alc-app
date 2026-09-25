import type {
  ApiMeasurement, ApiEmployee, MeasurementsResponse, MeasurementFilter, MeasurementResult, FaceDataEntry,
  // Tenko
  TenkoSchedule, CreateTenkoSchedule, UpdateTenkoSchedule, TenkoScheduleFilter, TenkoSchedulesResponse,
  TenkoSession, StartTenkoSession, SubmitAlcoholResult, SubmitMedicalData, SubmitSelfDeclaration,
  SubmitDailyInspection, SubmitOperationReport, CancelTenkoSession, InterruptSession, ResumeSession,
  SubmitManagerJudgment,
  TenkoRemoteEscalationReason,
  TenkoSessionFilter, TenkoSessionsResponse,
  TenkoRecordFilter,
  WebhookConfig, CreateWebhookConfig, WebhookDelivery,
  TenkoDashboard,
  EmployeeHealthBaseline, CreateHealthBaseline, UpdateHealthBaseline,
  EquipmentFailure, CreateEquipmentFailure, UpdateEquipmentFailure, EquipmentFailureFilter, EquipmentFailuresResponse,
  // Timecard
  TimecardCard, CreateTimecardCard, TimePunchFilter, TimePunchesResponse,
  // Device Registration
  Device, DeviceRegistrationRequest, CreateRegistrationResponse, RegistrationStatusResponse,
  ClaimRegistrationRequest, ClaimRegistrationResponse, CreateTokenResponse, CreatePermanentQrResponse, ApproveDeviceResponse,
  DeviceSettingsResponse, CallSchedule,
  AuthorizeRepairResponse, RePairRequest, RePairResponse,
  DailyHealthResponse, VehicleCategories, CarInspectionLookupResponse,
  GuidanceRecord, CreateGuidanceRecord, GuidanceRecordsResponse, GuidanceRecordAttachment,
  CommunicationItem, CreateCommunicationItem, CommunicationItemsResponse,
  // Hub measurements (CoreS3 統合ハブ)
  HubMeasurementsResponse,
  // Driver master sync (Refs ippoan/alc-app-s3#125)
  DriverMasterSyncResult,
} from '~/types'
import { createAuthFetch } from '@ippoan/auth-client'
import {
  withTimeout, asTimeoutError, fetchWithTimeout, UPLOAD_FETCH_TIMEOUT_MS,
} from '~/utils/fetch-timeout'

let apiBase = ''
let getAccessToken: (() => string | null) | null = null
let getDeviceTenantId: (() => string | null) | null = null
let tokenRefresher: (() => Promise<void>) | null = null
// キオスク device JWT getter (#434 3b)。設定されていて admin JWT が無い時、
// JSON リクエストを same-origin proxy (/api/proxy) 経由に切替える。
let getKioskDeviceJwt: (() => Promise<string | null>) | null = null
// 運行管理者席 (VoiceS3R) の device JWT getter (Refs #337)。**キオスクの getter とは別物**で、
// `scope: 'manager-device'` を渡した呼び出しだけがこちらを使う。admin JWT が無いときだけ動く。
let getManagerDeviceJwt: (() => Promise<string | null>) | null = null
// 血圧測定台 (ATOM S3) の device JWT getter (Refs #353)。**上の 2 つとは別物**で、
// `scope: 'bp-station'` を渡した呼び出しだけがこちらを使う。admin JWT が無いときだけ動く。
//
// ★ **測定台と決着した画面だけがこの getter を入れる**。`scope: 'bp-station'` を付けた
// 4 本は**キオスクの点呼と共用**の口なので、CoreS3 のキオスクでは getter が未設定のまま
// = 下の `&& getBpStationDeviceJwt` で素通りし、従来どおりキオスクの鍵へ進む
// (キオスクの挙動は 1 ミリも変わらない)。
//
// 入れ方は 2 つある (Refs ippoan/alc-app#368):
//   - `initApi` の引数 … `?station=bp` 付きで開いた画面 (起動の時点で分かっている)
//   - {@link setBpStationJwtGetter} … 端末の名乗り (`DEVICE bp-station`) で決着した画面。
//     **決着は起動の数秒後**なので、`initApi` (起動時 1 回きり) では間に合わない
let getBpStationDeviceJwt: (() => Promise<string | null>) | null = null

// JSON 経路の transport (ヘッダー付与 + 401→refresh→retry single-flight) は
// @ippoan/auth-client の createAuthFetch に集約 (Refs ippoan/auth-worker#257)。
// blob / FormData 系の raw fetch (uploadFacePhoto 等) は proxyRawFetch を使用
let authFetch: (<T>(path: string, init?: RequestInit) => Promise<T>) | null = null
// admin browser JWT を same-origin proxy (/api/proxy) 経由で送るための 2 つ目のインスタンス
// (#434 step 3d caller #3)。baseUrl='' で same-origin、X-Tenant-ID は付けない (proxy が注入)。
// authFetch と同じ 401→refresh→retry を再利用するため createAuthFetch をもう 1 個作る。
let proxyAuthFetch: (<T>(path: string, init?: RequestInit) => Promise<T>) | null = null

/** `/api/...` を same-origin proxy path `/api/proxy/...` に書き換える (proxyRequest と同規約)。 */
function toProxyPath(path: string): string {
  return path.replace(/^\/api\//, '/api/proxy/')
}

export function initApi(
  baseUrl: string,
  tokenGetter?: () => string | null,
  tenantGetter?: () => string | null,
  refresher?: () => Promise<void>,
  deviceJwtGetter?: () => Promise<string | null>,
  managerDeviceJwtGetter?: () => Promise<string | null>,
  bpStationDeviceJwtGetter?: () => Promise<string | null>,
) {
  apiBase = baseUrl.replace(/\/$/, '')
  getAccessToken = tokenGetter || null
  getDeviceTenantId = tenantGetter || null
  tokenRefresher = refresher || null
  getKioskDeviceJwt = deviceJwtGetter || null
  getManagerDeviceJwt = managerDeviceJwtGetter || null
  getBpStationDeviceJwt = bpStationDeviceJwtGetter || null
  // authFetch は **admin JWT が無い fallback 経路専用** (admin は proxyAuthFetch へ行く)。
  // よって token は常に付けず、X-Tenant-ID kiosk fallback だけ載せる。
  authFetch = apiBase
    ? createAuthFetch({
        baseUrl: apiBase,
        tokenGetter: () => null,
        tenantIdGetter: () => getDeviceTenantId?.() ?? null,
        tokenRefresher: refresher,
        errorLabel: 'API エラー',
      })
    : null
  // proxy 経路は same-origin (/api/proxy) なので apiBase 非依存。admin JWT があるときだけ
  // 呼ばれる (request() の guard 後) ので getAccessToken は non-null。X-Tenant-ID は
  // proxy (auth-worker /alc-proxy) が検証済み JWT から注入するため consumer は送らない。
  proxyAuthFetch = createAuthFetch({
    baseUrl: '',
    tokenGetter: () => getAccessToken!(),
    tenantIdGetter: () => null,
    tokenRefresher: refresher,
    errorLabel: 'API エラー',
  })
}

/**
 * 測定台の device JWT getter を**後から**入れ替える (Refs ippoan/alc-app#368)。
 *
 * # なぜ後入れの口が要るか
 *
 * `initApi` は**起動時 1 回きり**だが、「この PC が測定台か」が決まるのはその数秒後 —
 * 端末の名乗り (`DEVICE bp-station`) は `useSerialArbiter` の probe が 1 秒ごとに
 * 最大 8 回撃って決着する (`arbitratedDeviceKind`)。`?station=bp` を付けない URL で
 * 開いた画面 (ハンバーガーの「血圧測定」から入った画面) は、決着した時点でここから
 * getter を入れる (呼ぶのは `pages/index.vue`)。
 *
 * # 未確定のあいだは入れないこと
 *
 * `scope: 'bp-station'` の 4 本は**キオスクの点呼と共用**で、getter が在るのに JWT が
 * 取れなければ `request()` は**投げる** (暗黙のフォールバックを作らない、Refs #337)。
 * ⇒ **未確定のまま入れると、CoreS3 キオスクの点呼 4 本が全部落ちる。**
 * 入れるのは「測定台と決着したとき」だけで、未確定・キオスクのときは入れない。
 *
 * `null` を渡せば外せる (従来どおりキオスクの鍵へ進む形に戻る)。
 */
export function setBpStationJwtGetter(getter: (() => Promise<string | null>) | null): void {
  getBpStationDeviceJwt = getter
}

/** 認証ヘッダーを構築 */
// proxyRawFetch の fallback (= admin/device JWT が無い経路) でだけ使う。JWT がある場合は
// proxyRawFetch が proxy 経由にするためここには来ない。残るは X-Tenant-ID kiosk fallback のみ。
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const tenantId = getDeviceTenantId?.()
  if (tenantId) headers['X-Tenant-ID'] = tenantId
  return headers
}

/**
 * その呼び出しが**どの資格で通るか**を明示する印 (Refs #337)。
 *
 * - `'default'` … 従来どおり `admin JWT` → `キオスクの device JWT` → 直 fetch。
 *   **キオスクの点呼 (`useTenkoKiosk`) は全部これ** — 運行管理者トークンには絶対に触れない
 * - `'manager-device'` … **運行管理者席 (VoiceS3R) の鍵で通す口**。auth-worker#573 が
 *   role `device-tenko-manager` に許した**予定の口だけ**に付ける。admin JWT があれば
 *   従来どおりそちらが優先 (admin タブは今までと 1 ミリも変わらない)
 * - `'bp-station'` … **血圧測定台 (ATOM S3 を挿した PC) の鍵で通す口** (Refs #353)。
 *   測定台は `devices` に行を持たず `deviceId` が構造的に空なので、admin JWT も
 *   キオスクの device JWT も持たない。auth-worker の `BP_STATION_ROUTES` が role
 *   `device-bp-station` に許した**4 本すべて**に付ける:
 *   `POST /api/employees/lookup` / `GET /api/employees/face-data` /
 *   `POST /api/measurements/start` / `PUT /api/measurements/{id}`。
 *   **1 本でも付け忘れると、その口だけ下の `authFetch` (X-Tenant-ID 直 fetch) に落ちる** —
 *   測定台は admin JWT も キオスクの鍵も持たないので、付け忘れた口は必ず無認証経路になる。
 *   4 本は点呼と共用なので、**getter を入れるのは測定台と決着した画面だけ**
 *   (`?station=bp` 付きの URL なら `initApi` で、端末の名乗りで決着したなら
 *   {@link setBpStationJwtGetter} で。どちらも `pages/index.vue`)。**未確定のあいだと
 *   キオスクでは getter が無く素通りする** (Refs ippoan/alc-app#368)
 *
 * **暗黙のフォールバックを作らない**のが肝。`'manager-device'` の呼び出しが
 * キオスクの鍵へ落ちると、サーバは `device-kiosk` の許可表で弾いて 403 を返すだけで、
 * 画面には理由が出ない (= #337 の症状そのもの)。だから落とさずに理由を投げる。
 * `'bp-station'` も同じ — getter が在るのに JWT が取れなければ**投げる**。キオスクの鍵や
 * 無認証 fetch へ落とすと、サーバは 403 を返すか tenant だけで通してしまう。
 *
 * **だから getter は「測定台と決着したとき」にしか入れない** — 未確定のまま入れると、
 * この fail-closed がそのままキオスクの点呼 4 本を落とす
 * ({@link setBpStationJwtGetter}、Refs ippoan/alc-app#368)。
 */
export type RequestTokenScope = 'default' | 'manager-device' | 'bp-station'

/**
 * 運行管理者席の端末で認証できなかったときの文言 (#338 と同じ趣旨 —
 * **無言で 403 にしない**)。`/device/setup` で用途「運行管理者席」の登録がまだの鍵も、
 * auth-worker が 401 を返すので (403 ではなく) このメッセージになる。
 */
export const MANAGER_DEVICE_AUTH_FAILED_MESSAGE
  = '運行管理者席の端末で認証できませんでした。この席の警告デバイス (VoiceS3R) が USB でつながっていて、'
    + '用途「運行管理者席」で鍵が登録されているか確認してください'

/**
 * 血圧測定台で認証できなかったときの文言 (Refs #353)。**無言で 403 にも
 * 無認証 fetch にも落とさない** — `/device/setup` で用途「測定台」の登録がまだの鍵も、
 * auth-worker が 401 を返すのでこのメッセージになる。
 */
export const BP_STATION_DEVICE_AUTH_FAILED_MESSAGE
  = '血圧測定台の端末で認証できませんでした。この測定台の ATOM S3 が USB でつながっていて、'
    + '用途「測定台」で鍵が登録されているか確認してください'

async function request<T>(
  path: string,
  options: RequestInit = {},
  scope: RequestTokenScope = 'default',
): Promise<T> {
  if (!authFetch) throw new Error('API 未初期化: initApi() を呼んでください')
  // 上限 (timeout) の `AbortSignal.timeout()` はここ 1 箇所で載せる
  // (実装は `~/utils/fetch-timeout`。Refs ippoan/alc-app#338)。下の 3 経路はどれも
  // この init をそのまま fetch へ素通しする (createAuthFetch も `{ ...init }` で signal を
  // 渡す) ので、admin / device JWT / X-Tenant-ID fallback の全部に同じ上限が効く。
  const opts = withTimeout(options)
  try {
    // admin browser JWT があれば same-origin proxy (/api/proxy, #434 step 3d) 経由にする。
    // proxy (auth-worker /alc-proxy) が JWT を検証して X-Tenant-ID + X-User-* を注入し
    // OIDC mint する (Cloud Run IAM lockdown 後も到達可)。401→refresh→retry を効かせるため
    // proxyAuthFetch (createAuthFetch インスタンス) を使う。
    if (getAccessToken?.()) {
      // proxyAuthFetch は authFetch と同時に initApi で必ず設定される (上の guard を
      // 通過 = initApi 済み) ので non-null。
      return await proxyAuthFetch!<T>(toProxyPath(path), opts)
    }
    // 運行管理者タブ: admin JWT が無く、この呼び出しが運行管理者の口なら
    // **運行管理者席の鍵**で通す (#337)。**キオスクの鍵へは落とさない** — 落としても
    // auth-worker の `device-kiosk` 許可表で 403 になるだけで、理由が画面に出ないため。
    // getter 自体が未設定の環境 (初期化で渡していない) は従来どおり下へ抜ける。
    if (scope === 'manager-device' && getManagerDeviceJwt) {
      const managerJwt = await getManagerDeviceJwt()
      if (!managerJwt) throw new Error(MANAGER_DEVICE_AUTH_FAILED_MESSAGE)
      return await proxyRequest<T>(path, managerJwt, opts)
    }
    // 血圧測定台: admin JWT が無く、この呼び出しが測定台の口なら **測定台の鍵**で通す
    // (#353)。**キオスクの鍵にも無認証 fetch にも落とさない** — 落としても
    // auth-worker の許可表で 403 になるか、tenant だけの無認証経路になるため。
    // getter 自体が未設定の環境 (= 測定台として開いていない画面) は従来どおり下へ抜ける。
    if (scope === 'bp-station' && getBpStationDeviceJwt) {
      const bpJwt = await getBpStationDeviceJwt()
      if (!bpJwt) throw new Error(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
      return await proxyRequest<T>(path, bpJwt, opts)
    }
    // キオスク: admin JWT が無く device JWT があれば same-origin proxy 経由。
    // proxy が device JWT を検証して X-Tenant-ID に変換する。
    if (getKioskDeviceJwt) {
      const jwt = await getKioskDeviceJwt()
      if (jwt) return await proxyRequest<T>(path, jwt, opts)
    }
    // 認証情報なし: 従来の X-Tenant-ID 直 fetch に fallback (段階移行で非破壊)。
    return await authFetch<T>(path, opts)
  }
  catch (e) {
    // timeout は素の `TimeoutError` のままだと画面に出せないので文言に置き換える。
    // 書き込み (POST 等) は**サーバ側で成功していることがある**ので、method を渡して
    // 「もう一度お試しください」と書かない口に振り分ける (Refs ippoan/alc-app#338)。
    throw asTimeoutError(e, options.method)
  }
}

/** device JWT を Bearer に載せて same-origin proxy (/api/proxy) に転送する。 */
async function proxyRequest<T>(path: string, jwt: string, options: RequestInit): Promise<T> {
  return bearerRequest<T>(toProxyPath(path), jwt, options)
}

/** JWT を Bearer に載せて same-origin URL を叩く (proxy 経路と server route 直叩きの共通部)。 */
async function bearerRequest<T>(url: string, jwt: string, options: RequestInit): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${jwt}`)
  // 文字列の本文 (このモジュールでは JSON.stringify したもの) に Content-Type が無いと、
  // ブラウザは text/plain を付けて送り、/api/proxy はそれをそのまま転送するので上流が
  // JSON として受けない (415 になっていた。Refs #238)。管理者の経路 (createAuthFetch) と
  // 同じく JSON を付ける。明示された Content-Type と FormData / Blob の本文は触らない
  if (typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetchWithTimeout(url, { ...options, headers })
  if (!res.ok) {
    const body = await res.text()
    // **status を Error に載せる。** 呼び出し側 (TimecardManager 等) は既に
    // `e?.status === 409` の形で見ているのに、ここが文字列しか投げていなかった
    throw Object.assign(new Error(`API エラー (${res.status}): ${body || res.statusText}`), {
      status: res.status,
    })
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * 端末登録前 (認証情報が一切無い) の public ingest 経路専用。alc-app 自身の Nitro server
 * route (`server/api/devices/register/{request,status/[code],claim}`) を same-origin で
 * 叩く。これらの route は auth-worker `/alc-internal-proxy` 経由で rust に forward される
 * (Refs ippoan/rust-alc-api#480)。
 *
 * `request()` の X-Tenant-ID 直 fetch fallback をここで使うと、rust-alc-api の Cloud Run
 * IAM lockdown 後は直叩きが 403 (CORS ヘッダー無し) になり「Failed to fetch」になる —
 * この関数はその bug を踏まないための専用経路。
 */
async function publicIngestRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  const res = await fetchWithTimeout(path, { ...options, headers })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API エラー (${res.status}): ${body || res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * blob / FormData 系の raw fetch を認証付きで投げ Response をそのまま返す (#434 step 3d)。
 * admin browser JWT or device JWT があれば same-origin proxy (/api/proxy) 経由
 * (proxy が X-Tenant-ID 注入 + OIDC mint)。どちらも無ければ従来の `${apiBase}` 直叩き
 * (X-Tenant-ID fallback) に倒す (lockdown 前の非破壊)。
 */
async function proxyRawFetch(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  let jwt = getAccessToken?.() ?? null
  if (!jwt && getKioskDeviceJwt) jwt = await getKioskDeviceJwt()
  if (jwt) {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${jwt}`)
    return fetchWithTimeout(toProxyPath(path), { ...init, headers }, timeoutMs)
  }
  // 認証情報なし: 直叩き fallback
  if (!apiBase) throw new Error('API 未初期化')
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(buildAuthHeaders())) headers.set(k, v)
  return fetchWithTimeout(`${apiBase}${path}`, { ...init, headers }, timeoutMs)
}

/** 測定結果を保存 */
export async function saveMeasurement(result: MeasurementResult, facePhotoBlob?: Blob): Promise<ApiMeasurement> {
  let facePhotoUrl: string | undefined

  if (facePhotoBlob) {
    facePhotoUrl = await uploadFacePhoto(facePhotoBlob)
  }

  return request<ApiMeasurement>('/api/measurements', {
    method: 'POST',
    body: JSON.stringify({
      employee_id: result.employeeId,
      alcohol_value: result.alcoholValue,
      result_type: result.resultType,
      device_use_count: result.deviceUseCount,
      face_photo_url: facePhotoUrl || result.facePhotoUrl,
      measured_at: result.measuredAt.toISOString(),
      temperature: result.temperature,
      systolic: result.systolic,
      diastolic: result.diastolic,
      pulse: result.pulse,
      medical_measured_at: result.medicalMeasuredAt?.toISOString(),
      record_as_tenko: true,
      tenko_type: result.tenkoType ?? 'normal',
      carins_cert_no: result.carinsCertNo,
      carins_vehicle_id: result.carinsVehicleId,
    }),
  })
}

/**
 * 測定を開始 (status: started)。
 *
 * **血圧測定台の 4 本のうちの 1 本** (`scope: 'bp-station'`、Refs #353)。測定台として
 * 開いた画面だけが測定台の鍵で通り、キオスクの点呼では getter が無いので従来どおり
 * キオスクの鍵へ進む。
 */
export async function startMeasurement(employeeId: string): Promise<ApiMeasurement> {
  return request<ApiMeasurement>('/api/measurements/start', {
    method: 'POST',
    body: JSON.stringify({ employee_id: employeeId }),
  }, 'bp-station')
}

/** 測定レコードを更新 (血圧測定台の 4 本のうちの 1 本、Refs #353) */
export async function updateMeasurement(id: string, data: Record<string, unknown>): Promise<ApiMeasurement> {
  return request<ApiMeasurement>(`/api/measurements/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }, 'bp-station')
}

/** 測定履歴を取得 */
export async function getMeasurements(filter: MeasurementFilter = {}): Promise<MeasurementsResponse> {
  const params = new URLSearchParams()
  if (filter.employee_id) params.set('employee_id', filter.employee_id)
  if (filter.result_type) params.set('result_type', filter.result_type)
  if (filter.date_from) params.set('date_from', filter.date_from)
  if (filter.date_to) params.set('date_to', filter.date_to)
  if (filter.page) params.set('page', String(filter.page))
  if (filter.per_page) params.set('per_page', String(filter.per_page))
  if (filter.status) params.set('status', filter.status)

  const qs = params.toString()
  return request<MeasurementsResponse>(`/api/measurements${qs ? '?' + qs : ''}`)
}

/** 測定結果詳細を取得 */
export async function getMeasurement(id: string): Promise<ApiMeasurement> {
  return request<ApiMeasurement>(`/api/measurements/${id}`)
}

/** 乗務員一覧を取得 */
export async function getEmployees(): Promise<ApiEmployee[]> {
  return request<ApiEmployee[]>('/api/employees')
}

/**
 * NFC ID で乗務員を検索する (Refs ippoan/rust-alc-api#644)。**NFC ID を URL
 * (request log) に載せないよう POST** — 免許証 IC 由来の 16 桁が Worker / auth-worker /
 * API / Cloud Run の各層のアクセスログと devtools に平文で残るのを避ける
 * (`lookupCarInspection` と同じ判断)。NFC ID は console に出さない
 * (simplify-reviewer の検査点)
 *
 * **血圧測定台が最初に叩く口** (`scope: 'bp-station'`、Refs #353) — ここが素通りすると
 * 測定台は 1 本目から無認証経路に落ちる。
 */
export async function getEmployeeByNfcId(nfcId: string): Promise<ApiEmployee> {
  return request<ApiEmployee>('/api/employees/lookup', {
    method: 'POST',
    body: JSON.stringify({ nfc_id: nfcId }),
  }, 'bp-station')
}

/** 社員番号で乗務員を検索 */
export async function getEmployeeByCode(code: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/by-code/${encodeURIComponent(code)}`)
}

/** 乗務員をIDで取得 */
export async function getEmployeeById(id: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${encodeURIComponent(id)}`)
}

/** 乗務員を登録 */
export async function createEmployee(data: { code?: string; nfc_id?: string; name: string; role?: string[] }): Promise<ApiEmployee> {
  return request<ApiEmployee>('/api/employees', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** 乗務員情報を更新 */
export async function updateEmployee(id: string, data: { name: string; code?: string | null; role?: string[] }): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/** 乗務員を削除 (論理削除) */
export async function deleteEmployee(id: string): Promise<void> {
  await request<void>(`/api/employees/${id}`, {
    method: 'DELETE',
  })
}

/** 乗務員の顔写真 URL + 特徴量を更新 */
export async function updateEmployeeFace(
  id: string,
  facePhotoUrl?: string,
  faceEmbedding?: number[],
  faceModelVersion?: string,
): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${id}/face`, {
    method: 'PUT',
    body: JSON.stringify({
      face_photo_url: facePhotoUrl ?? null,
      face_embedding: faceEmbedding ?? null,
      face_model_version: faceModelVersion ?? null,
    }),
  })
}

/** 顔登録を承認 */
export async function approveFace(employeeId: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${employeeId}/face/approve`, { method: 'PUT' })
}

/** 顔登録を却下 */
export async function rejectFace(employeeId: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${employeeId}/face/reject`, { method: 'PUT' })
}

/** 全乗務員の顔特徴量を取得 (同期用。血圧測定台の 4 本のうちの 1 本、Refs #353) */
export async function getFaceData(): Promise<FaceDataEntry[]> {
  return request<FaceDataEntry[]>('/api/employees/face-data', {}, 'bp-station')
}

/** 乗務員の NFC ID を更新 */
export async function updateEmployeeNfcId(id: string, nfcId: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${id}/nfc`, {
    method: 'PUT',
    body: JSON.stringify({ nfc_id: nfcId }),
  })
}

/** 乗務員の免許証情報を更新 */
export async function updateEmployeeLicense(
  id: string,
  licenseIssueDate?: string | null,
  licenseExpiryDate?: string | null,
): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${id}/license`, {
    method: 'PUT',
    body: JSON.stringify({
      license_issue_date: licenseIssueDate ?? null,
      license_expiry_date: licenseExpiryDate ?? null,
    }),
  })
}

/**
 * 乗務員の免許証登録を解除 (交付年月日・有効期限・nfc_id を消す)。
 * `updateEmployeeLicense` (PUT) は backend が COALESCE なので null では消せない。
 * 消すのは専用の DELETE (Refs ippoan/rust-alc-api#611)。
 */
export async function clearEmployeeLicense(id: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/${id}/license`, { method: 'DELETE' })
}

/**
 * 指静脈テンプレートを登録 (登録画面から 2 回分の特徴量をまとめて PUT、
 * Refs ippoan/vein-match#20, ippoan/rust-alc-api#678)。
 *
 * 422 (`{"error": "…", "message": "…"}`) は呼び出し側が {@link apiErrorCode} /
 * {@link apiErrorMessage} で読める。404 (`employee_not_found`) は `apiErrorCode` が
 * そのまま拾う (本文が `{"error":"employee_not_found"}` 形式のため)。
 */
export async function putVeinTemplate(
  employeeId: string,
  charas: string[],
): Promise<{ employee_id: string; updated_at: string }> {
  return request<{ employee_id: string; updated_at: string }>(`/api/vein/templates/${encodeURIComponent(employeeId)}`, {
    method: 'PUT',
    body: JSON.stringify({ charas }),
  })
}

/**
 * 免許証タブ「theearth から乗務員マスタを同期」(Refs ippoan/alc-app-s3#125)。
 * rust-alc-api ではなく alc-app 自身の server route `/api/driver-master/run` を
 * same-origin で叩く (proxy 経由にしない)。route が admin browser JWT を introspect
 * して tenant_id を決め、dtako-scraper-relay に同期を依頼する — ここからは
 * tenant_id を送らない (送っても route は読まない)。
 */
export async function runDriverMasterSync(): Promise<DriverMasterSyncResult> {
  const jwt = getAccessToken?.()
  if (!jwt) throw new Error('ログインが必要です')
  return bearerRequest<DriverMasterSyncResult>('/api/driver-master/run', jwt, { method: 'POST' })
}

/** 認証付きプロキシ経由でバイナリを取得し、object URL にする (顔写真・録画動画で共用)。 */
async function fetchObjectUrl(path: string): Promise<string | null> {
  if (!apiBase) return null

  try {
    const res = await proxyRawFetch(path, { cache: 'no-store' })
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

/** 測定の顔写真を取得 (認証付きプロキシ経由) */
export async function fetchFacePhoto(measurementId: string): Promise<string | null> {
  return fetchObjectUrl(`/api/measurements/${measurementId}/face-photo`)
}

/** 測定の録画動画を取得 (認証付きプロキシ経由) */
export async function fetchMeasurementVideo(measurementId: string): Promise<string | null> {
  return fetchObjectUrl(`/api/measurements/${measurementId}/video`)
}

/** 顔写真をアップロード */
export async function uploadFacePhoto(blob: Blob): Promise<string> {
  const formData = new FormData()
  formData.append('file', blob, 'face.jpg')

  const res = await proxyRawFetch(`/api/upload/face-photo`, {
    method: 'POST',
    body: formData,
  }, UPLOAD_FETCH_TIMEOUT_MS)

  if (!res.ok) throw new Error(`アップロード失敗 (${res.status})`)
  const data = await res.json()
  return data.url
}

/** 運行報告の音声をアップロード */
export async function uploadReportAudio(blob: Blob): Promise<string> {
  const formData = new FormData()
  formData.append('file', blob, 'report.webm')

  const res = await proxyRawFetch(`/api/upload/report-audio`, {
    method: 'POST',
    body: formData,
  }, UPLOAD_FETCH_TIMEOUT_MS)

  if (!res.ok) throw new Error(`音声アップロード失敗 (${res.status})`)
  const data = await res.json()
  return data.url
}

export async function uploadBlowVideo(blob: Blob): Promise<string> {
  const formData = new FormData()
  formData.append('file', blob, 'blow.webm')

  const res = await proxyRawFetch(`/api/upload/blow-video`, {
    method: 'POST',
    body: formData,
  }, UPLOAD_FETCH_TIMEOUT_MS)

  if (!res.ok) throw new Error(`録画アップロード失敗 (${res.status})`)
  const data = await res.json()
  return data.url
}

// ============================================================
// 自動点呼 (Tenko) API
// ============================================================

/** フィルタを URLSearchParams に変換 */
function toParams(filter: object): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filter)) {
    if (v != null && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** CSV ダウンロード (blob → ブラウザ保存) */
async function downloadCsv(path: string, filename: string): Promise<void> {
  const res = await proxyRawFetch(path, {})
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`CSV ダウンロード失敗 (${res.status}): ${body || res.statusText}`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// --- スケジュール ---
//
// ★ 予定の口は**運行管理者の権限** (Refs #337)。運行管理者タブは admin browser JWT を
// 持たない (NFC + 顔認証で入る) ので、admin JWT が無いときは**運行管理者席の鍵**
// (`scope: 'manager-device'`) で通す。auth-worker#573 が role `device-tenko-manager` に
// 許したのは下の 6 本 (`GET,POST /api/tenko/schedules` / `POST .../batch` /
// `GET,PUT,DELETE .../{id}`) だけで、**ここに付ける印とサーバの許可表は 1 対 1** に対応する。
//
// **`getPendingSchedules` だけは `default` のまま。** あれはキオスクが点呼の入口で自分の
// 予定を引く口で、`KIOSK_ROUTES` に元から入っている — **キオスクの点呼が運行管理者
// トークンを使ってはいけない** (使えば運行管理者席の鍵が乗務員端末にも要ることになる)。

export async function createSchedule(data: CreateTenkoSchedule): Promise<TenkoSchedule> {
  return request<TenkoSchedule>('/api/tenko/schedules', {
    method: 'POST',
    body: JSON.stringify(data),
  }, 'manager-device')
}

export async function batchCreateSchedules(schedules: CreateTenkoSchedule[]): Promise<TenkoSchedule[]> {
  return request<TenkoSchedule[]>('/api/tenko/schedules/batch', {
    method: 'POST',
    body: JSON.stringify({ schedules }),
  }, 'manager-device')
}

export async function listSchedules(filter: TenkoScheduleFilter = {}): Promise<TenkoSchedulesResponse> {
  return request<TenkoSchedulesResponse>(`/api/tenko/schedules${toParams(filter)}`, {}, 'manager-device')
}

export async function getSchedule(id: string): Promise<TenkoSchedule> {
  return request<TenkoSchedule>(`/api/tenko/schedules/${id}`, {}, 'manager-device')
}

export async function updateSchedule(id: string, data: UpdateTenkoSchedule): Promise<TenkoSchedule> {
  return request<TenkoSchedule>(`/api/tenko/schedules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }, 'manager-device')
}

export async function deleteSchedule(id: string): Promise<void> {
  await request<void>(`/api/tenko/schedules/${id}`, { method: 'DELETE' }, 'manager-device')
}

/** キオスクが点呼の入口で引く「自分の未消化の予定」。**運行管理者トークンは使わない** (#337)。 */
export async function getPendingSchedules(employeeId: string): Promise<TenkoSchedule[]> {
  return request<TenkoSchedule[]>(`/api/tenko/schedules/pending/${employeeId}`)
}

// --- セッション (キオスク) ---

export async function startTenkoSession(data: StartTenkoSession): Promise<TenkoSession> {
  return request<TenkoSession>('/api/tenko/sessions/start', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getTenkoSession(id: string): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${id}`)
}

export async function submitAlcohol(sessionId: string, data: SubmitAlcoholResult): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/alcohol`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function submitMedical(sessionId: string, data: SubmitMedicalData): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/medical`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function submitSelfDeclaration(sessionId: string, data: SubmitSelfDeclaration): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/self-declaration`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function submitDailyInspection(sessionId: string, data: SubmitDailyInspection): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/daily-inspection`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function confirmInstruction(sessionId: string): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/instruction-confirm`, {
    method: 'PUT',
    body: JSON.stringify({}),
  })
}

export async function submitReport(sessionId: string, data: SubmitOperationReport): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/report`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/**
 * 自動点呼を遠隔点呼へ切り替えたことをサーバへ伝える (Refs ippoan/alc-app-s3#135)。
 *
 * 血圧を必須にすると血圧計が壊れた日に全車が出庫できなくなるため、測れないときは
 * 運行管理者が遠隔で対応する経路へ移す。**セッションは切り替えず同じ id のまま**で、
 * サーバは「この点呼は途中から遠隔になった」ことだけを記録する。
 *
 * `reason` は**必須** (サーバが空文字を弾く)。呼び出し側は
 * `TENKO_REMOTE_ESCALATION_REASONS` から選ばせた語を渡すこと。
 *
 * サーバ側の口は別 PR。**まだ無くても画面は遠隔へ入れる** — 呼び出し側は失敗を握り潰す。
 */
export async function escalateTenkoSessionToRemote(
  sessionId: string,
  reason: TenkoRemoteEscalationReason,
): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/escalate-remote`, {
    method: 'PUT',
    body: JSON.stringify({ reason }),
  })
}

export async function cancelTenkoSession(sessionId: string, data: CancelTenkoSession): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * 運行管理者が点呼の OK/NG を判定して記録する (Refs ippoan/alc-app#315)。
 * NG でも `status` は変えない (点呼は完了扱いのまま、判定だけ記録する)。
 */
export async function submitManagerJudgment(sessionId: string, data: SubmitManagerJudgment): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/judgment`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// --- セッション (管理者) ---

export async function listTenkoSessions(filter: TenkoSessionFilter = {}): Promise<TenkoSessionsResponse> {
  return request<TenkoSessionsResponse>(`/api/tenko/sessions${toParams(filter)}`)
}

export async function getTenkoDashboard(): Promise<TenkoDashboard> {
  return request<TenkoDashboard>('/api/tenko/dashboard')
}

export async function interruptTenkoSession(sessionId: string, data: InterruptSession = {}): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/interrupt`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function resumeTenkoSession(sessionId: string, data: ResumeSession): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * キオスクが自分で拾った点呼を「続きから再開」したことをサーバに残す
 * (Refs ippoan/alc-app#351、口は ippoan/rust-alc-api#676)。
 *
 * 上の `resumeTenkoSession` (管理者用 `/resume`) とは**別の口**。あちらは `AuthUser` 必須で
 * `status` を書き換えるが、こちらは `resumed_at` と `resume_reason` だけを書き、**`status` に
 * 触らない** (段の復元はキオスクがローカルでやる)。キオスクの device token で通る
 * (`auth-worker` の `KIOSK_ROUTES` に登録済み)。
 *
 * **再開は 1 セッションにつき 1 回まで** — 2 回目は 400 (`already_resumed`) が返る。
 */
export async function selfResumeTenkoSession(sessionId: string, data: ResumeSession): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/self-resume`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * rust-alc-api が 4xx で返す body (`{"error": "…", "message": "…"}`) を Error.message から
 * 取り出す ({@link apiErrorCode} / {@link apiErrorMessage} の共通実装)。
 *
 * この層は失敗を `API エラー (400): <body>` という **Error の文言**にして投げるので、
 * 呼び出し側が分岐したい「どの 4xx か」はそこからしか読めない。文言の作り方を知っているのは
 * この module なので、**取り出しもここに置く** (呼び出し側に書式を写さない)。
 *
 * 本文が JSON として読めなければ (プロキシの HTML エラーページ等) `null` —
 * 呼び出し側は「分からない失敗」として扱う (**分からない失敗を既知の 1 つに丸めない**)。
 */
function parseApiErrorBody(e: unknown): { error?: unknown; message?: unknown } | null {
  const text = e instanceof Error ? e.message : ''
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start)) as { error?: unknown; message?: unknown }
  }
  catch {
    return null
  }
}

/** {@link parseApiErrorBody} の `error` (コード) だけを取り出す。読めなければ `null`。 */
export function apiErrorCode(e: unknown): string | null {
  const body = parseApiErrorBody(e)
  return body && typeof body.error === 'string' ? body.error : null
}

/**
 * {@link parseApiErrorBody} の `message` (表示用文言) だけを取り出す。読めなければ `null`
 * (指静脈テンプレート登録の 422 表示用、Refs ippoan/rust-alc-api#678)。
 */
export function apiErrorMessage(e: unknown): string | null {
  const body = parseApiErrorBody(e)
  return body && typeof body.message === 'string' ? body.message : null
}

// --- レコード ---

export async function downloadTenkoRecordsCsv(filter: TenkoRecordFilter = {}): Promise<void> {
  await downloadCsv(`/api/tenko/records/csv${toParams(filter)}`, 'tenko-records.csv')
}

// --- Webhook ---

export async function createWebhook(data: CreateWebhookConfig): Promise<WebhookConfig> {
  return request<WebhookConfig>('/api/tenko/webhooks', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function listWebhooks(): Promise<WebhookConfig[]> {
  return request<WebhookConfig[]>('/api/tenko/webhooks')
}

export async function getWebhook(id: string): Promise<WebhookConfig> {
  return request<WebhookConfig>(`/api/tenko/webhooks/${id}`)
}

export async function deleteWebhook(id: string): Promise<void> {
  await request<void>(`/api/tenko/webhooks/${id}`, { method: 'DELETE' })
}

export async function getWebhookDeliveries(configId: string): Promise<WebhookDelivery[]> {
  return request<WebhookDelivery[]>(`/api/tenko/webhooks/${configId}/deliveries`)
}

// --- 健康基準値 ---

export async function createBaseline(data: CreateHealthBaseline): Promise<EmployeeHealthBaseline> {
  return request<EmployeeHealthBaseline>('/api/tenko/health-baselines', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function listBaselines(): Promise<EmployeeHealthBaseline[]> {
  return request<EmployeeHealthBaseline[]>('/api/tenko/health-baselines')
}

export async function getBaseline(employeeId: string): Promise<EmployeeHealthBaseline> {
  return request<EmployeeHealthBaseline>(`/api/tenko/health-baselines/${employeeId}`)
}

export async function updateBaseline(employeeId: string, data: UpdateHealthBaseline): Promise<EmployeeHealthBaseline> {
  return request<EmployeeHealthBaseline>(`/api/tenko/health-baselines/${employeeId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteBaseline(employeeId: string): Promise<void> {
  await request<void>(`/api/tenko/health-baselines/${employeeId}`, { method: 'DELETE' })
}

// --- 機器故障記録 ---

export async function createFailure(data: CreateEquipmentFailure): Promise<EquipmentFailure> {
  return request<EquipmentFailure>('/api/tenko/equipment-failures', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function listFailures(filter: EquipmentFailureFilter = {}): Promise<EquipmentFailuresResponse> {
  return request<EquipmentFailuresResponse>(`/api/tenko/equipment-failures${toParams(filter)}`)
}

export async function getFailure(id: string): Promise<EquipmentFailure> {
  return request<EquipmentFailure>(`/api/tenko/equipment-failures/${id}`)
}

export async function resolveFailure(id: string, data: UpdateEquipmentFailure): Promise<EquipmentFailure> {
  return request<EquipmentFailure>(`/api/tenko/equipment-failures/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function downloadFailuresCsv(filter: EquipmentFailureFilter = {}): Promise<void> {
  await downloadCsv(`/api/tenko/equipment-failures/csv${toParams(filter)}`, 'equipment-failures.csv')
}

// --- タイムカード ---

export async function createTimecardCard(data: CreateTimecardCard): Promise<TimecardCard> {
  return request<TimecardCard>('/api/timecard/cards', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function listTimecardCards(employeeId?: string): Promise<TimecardCard[]> {
  const params = employeeId ? `?employee_id=${employeeId}` : ''
  return request<TimecardCard[]>(`/api/timecard/cards${params}`)
}

export async function deleteTimecardCard(id: string): Promise<void> {
  await request<void>(`/api/timecard/cards/${id}`, { method: 'DELETE' })
}

/**
 * 打刻の失敗理由。**画面の文言を決めるためだけでなく、現地での切り分けのため**に
 * 分けてある — 「打刻に失敗しました」だけだと、未ペアリング・権限不足・通信障害が
 * 区別できず、実機の前に立った人が次に何をすればよいか分からない
 * (Refs ippoan/alc-app-s3#134 の実機確認で実際に詰まった)。
 */
export type PunchFailure =
  /** 端末に資格情報が無い / token が無効。ペアリングが要る */
  | 'unpaired'
  /** 認証は通ったが、この端末では打刻できない role */
  | 'forbidden'
  /** それ以外 (通信・上流エラー) */
  | 'failed'

/** `punchFailure` を載せた Error を作る。 */
function punchError(failure: PunchFailure, message: string, status?: number): Error {
  return Object.assign(new Error(message), { punchFailure: failure, status })
}

/**
 * 打刻する (Refs ippoan/alc-app-s3#134)。
 *
 * **rust-alc-api ではなく alc-app 自身の server route** (`/api/timecard/punch`) を
 * same-origin で叩く (`runDriverMasterSync` と同型)。route が cf-alc-recorder →
 * Durable Object と通し、**そこで打刻更新の合図 (`/watch-timecard`) が出る** —
 * rust に直行すると、この打刻だけ他の画面に即時反映されない。
 *
 * **応答は使わない (void)。** 端末の打刻と同じ ingest 経路に乗るので、
 * 社員名も当日一覧も返らない (社員の解決は ingest 側で凍結される)。
 * 呼び出し側は打刻後に `listTimePunches` を引き直すこと。
 *
 * tenant_id / device_id は route が JWT から決めるので**ここからは送らない**。
 *
 * 失敗は `punchFailure` を載せて投げる (上の型を参照)。
 */
export async function punchTimecard(cardId: string): Promise<void> {
  const jwt = getAccessToken?.() ?? (getKioskDeviceJwt ? await getKioskDeviceJwt() : null)
  // **ここを 'failed' に落とさない。** 未ペアリング端末はこの分岐にだけ来るので、
  // 一緒くたにすると「ペアリングすれば直る」と分からなくなる
  if (!jwt) throw punchError('unpaired', '端末がペアリングされていません')
  try {
    await bearerRequest<unknown>('/api/timecard/punch', jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: cardId }),
    })
  }
  catch (e) {
    const status = (e as { status?: number })?.status
    const message = (e as Error)?.message || '打刻に失敗しました'
    if (status === 401) throw punchError('unpaired', message, status)
    if (status === 403) throw punchError('forbidden', message, status)
    throw punchError('failed', message, status)
  }
}

export async function listTimePunches(filter: TimePunchFilter = {}): Promise<TimePunchesResponse> {
  return request<TimePunchesResponse>(`/api/timecard/punches${toParams(filter)}`)
}

export async function downloadTimePunchesCsv(filter: TimePunchFilter = {}): Promise<void> {
  await downloadCsv(`/api/timecard/punches/csv${toParams(filter)}`, 'time-punches.csv')
}

// ============================================================
// 中間点呼 (TenkoCall) 管理 API (admin)
// ============================================================
// 管理画面 (TenkoCallManager / EmployeeList) の admin 操作。request() 経由で
// same-origin proxy (/api/proxy → auth-worker /alc-proxy) に通す (#434 step 3d)。
// public な register / tenko (キオスク端末側) はここには含めない。

export interface TenkoCallNumber {
  id: number
  call_number: string
  tenant_id: string
  label: string | null
  created_at: string
}

export interface TenkoCallDriver {
  id: number
  phone_number: string
  driver_name: string
  call_number: string | null
  employee_code: string | null
  tenant_id: string
  created_at: string
}

export async function getTenkoCallNumbers(): Promise<TenkoCallNumber[]> {
  return request<TenkoCallNumber[]>('/api/tenko-call/numbers')
}

export async function addTenkoCallNumber(body: {
  call_number: string
  label: string | null
}): Promise<unknown> {
  return request<unknown>('/api/tenko-call/numbers', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function deleteTenkoCallNumber(id: number): Promise<void> {
  await request<void>(`/api/tenko-call/numbers/${id}`, { method: 'DELETE' })
}

export async function getTenkoCallDrivers(): Promise<TenkoCallDriver[]> {
  return request<TenkoCallDriver[]>('/api/tenko-call/drivers')
}

// ============ Device Registration ============

// 公開API (認証不要、端末登録前なので admin/device JWT が無い。same-origin Nitro
// server route 経由で叩く。Refs ippoan/rust-alc-api#480)
export async function createDeviceRegistrationRequest(deviceName?: string): Promise<CreateRegistrationResponse> {
  return publicIngestRequest<CreateRegistrationResponse>('/api/devices/register/request', {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName }),
  })
}

export async function checkDeviceRegistrationStatus(code: string): Promise<RegistrationStatusResponse> {
  return publicIngestRequest<RegistrationStatusResponse>(`/api/devices/register/status/${code}`)
}

export async function claimDeviceRegistration(data: ClaimRegistrationRequest): Promise<ClaimRegistrationResponse> {
  return publicIngestRequest<ClaimRegistrationResponse>('/api/devices/register/claim', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// テナント認証付きAPI
export async function listDevices(): Promise<Device[]> {
  return request<Device[]>('/api/devices')
}

export async function listPendingDeviceRegistrations(): Promise<DeviceRegistrationRequest[]> {
  return request<DeviceRegistrationRequest[]>('/api/devices/pending')
}

export async function createDeviceUrlToken(deviceName?: string, opts?: { is_device_owner?: boolean; is_dev_device?: boolean }): Promise<CreateTokenResponse> {
  return request<CreateTokenResponse>('/api/devices/register/create-token', {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName, ...opts }),
  })
}

export async function createPermanentQr(deviceName?: string, opts?: { is_device_owner?: boolean; is_dev_device?: boolean }): Promise<CreatePermanentQrResponse> {
  return request<CreatePermanentQrResponse>('/api/devices/register/create-permanent-qr', {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName, ...opts }),
  })
}

export async function createDeviceOwnerToken(deviceName?: string, opts?: { is_dev_device?: boolean }): Promise<CreatePermanentQrResponse> {
  return request<CreatePermanentQrResponse>('/api/devices/register/create-device-owner-token', {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName, ...opts }),
  })
}

export async function approveDevice(id: string, deviceName?: string): Promise<ApproveDeviceResponse> {
  return request<ApproveDeviceResponse>(`/api/devices/approve/${id}`, {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName }),
  })
}

export async function approveDeviceByCode(code: string): Promise<ApproveDeviceResponse> {
  return request<ApproveDeviceResponse>(`/api/devices/approve-by-code/${code}`, {
    method: 'POST',
  })
}

export async function rejectDevice(id: string): Promise<void> {
  return request<void>(`/api/devices/reject/${id}`, { method: 'POST' })
}

export async function disableDevice(id: string): Promise<void> {
  return request<void>(`/api/devices/disable/${id}`, { method: 'POST' })
}

export async function enableDevice(id: string): Promise<void> {
  return request<void>(`/api/devices/enable/${id}`, { method: 'POST' })
}

export async function deleteDevice(id: string): Promise<void> {
  return request<void>(`/api/devices/${id}`, { method: 'DELETE' })
}

// --- 再認証 (re-pair、Refs rust-alc-api#495) ---

// 管理者: 対象端末に時限 window を開ける (admin JWT 必須、テナント認証付き API)
export async function authorizeRepair(id: string, resetBinding = false): Promise<AuthorizeRepairResponse> {
  return request<AuthorizeRepairResponse>(`/api/devices/${id}/authorize-repair`, {
    method: 'POST',
    body: JSON.stringify({ reset_binding: resetBinding }),
  })
}

// 端末: window 内で device credential を再取得 (認証不要、public ingest 経路)
export async function rePairDevice(data: RePairRequest): Promise<RePairResponse> {
  return publicIngestRequest<RePairResponse>('/api/devices/re-pair', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getDeviceSettings(
  deviceId: string,
  settingsToken?: string | null,
): Promise<DeviceSettingsResponse> {
  // 承認時に発行された device 保有 token を X-Device-Token で送る (Refs rust-alc-api#388)。
  // 未発行の旧端末は従来どおりヘッダ無しで呼べる (backend 側が移行期互換)
  const options: RequestInit = settingsToken
    ? { headers: { 'X-Device-Token': settingsToken } }
    : {}
  return request<DeviceSettingsResponse>(`/api/devices/settings/${deviceId}`, options)
}

export async function updateDeviceCallSettings(
  id: string,
  callEnabled: boolean,
  callSchedule?: CallSchedule | null,
  alwaysOn?: boolean,
  bpEnabled?: boolean,
): Promise<void> {
  // always_on / bp_enabled は省略すると backend 側の COALESCE で現在値が保たれる
  // (rust-alc-api#642)。呼び元が触らない項目は渡さないこと。
  const body: Record<string, unknown> = { call_enabled: callEnabled, call_schedule: callSchedule }
  if (alwaysOn !== undefined) body.always_on = alwaysOn
  if (bpEnabled !== undefined) body.bp_enabled = bpEnabled
  return request<void>(`/api/devices/${id}/call-settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function updateDeviceLastLogin(
  deviceId: string,
  employeeId: string,
  employeeName: string,
  employeeRole: string[],
): Promise<void> {
  return request<void>('/api/devices/update-last-login', {
    method: 'PUT',
    body: JSON.stringify({ device_id: deviceId, employee_id: employeeId, employee_name: employeeName, employee_role: employeeRole }),
  })
}

export async function testFcmNotification(id: string): Promise<{ success: boolean; error?: string }> {
  return request<{ success: boolean; error?: string }>(`/api/devices/${id}/test-fcm`, {
    method: 'POST',
  })
}

export interface TestFcmAllResult {
  device_id: string
  device_name: string
  success: boolean
  error?: string
}

export async function testFcmAll(): Promise<{ sent: number; skipped: number; errors: number; results: TestFcmAllResult[] }> {
  return request(`/api/devices/test-fcm-all`, { method: 'POST' })
}

export interface TriggerUpdateResult {
  sent: number
  skipped: number
  already_updated: number
  errors: number
  results: TestFcmAllResult[]
}

export async function triggerUpdate(opts?: { device_ids?: string[]; dev_only?: boolean }): Promise<TriggerUpdateResult> {
  return request(`/api/devices/trigger-update`, { method: 'POST', body: JSON.stringify(opts ?? {}) })
}

// --- 携行品 ---

import type { CarryingItem, CreateCarryingItem, UpdateCarryingItem, CarryingItemCheckInput, DriverInfo } from '~/types'

export async function getCarryingItems(): Promise<CarryingItem[]> {
  return request('/api/carrying-items')
}

export async function createCarryingItem(data: CreateCarryingItem): Promise<CarryingItem> {
  return request('/api/carrying-items', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateCarryingItem(id: string, data: UpdateCarryingItem): Promise<CarryingItem> {
  return request(`/api/carrying-items/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function deleteCarryingItem(id: string): Promise<void> {
  return request(`/api/carrying-items/${id}`, { method: 'DELETE' })
}

export async function submitCarryingItemChecks(sessionId: string, checks: CarryingItemCheckInput[]): Promise<any> {
  return request(`/api/tenko/sessions/${sessionId}/carrying-items`, {
    method: 'PUT',
    body: JSON.stringify({ checks }),
  })
}

// --- 運転者情報 ---

export async function getDriverInfo(employeeId: string): Promise<DriverInfo> {
  return request(`/api/tenko/driver-info/${employeeId}`)
}

// --- 労働時間 (dtako) ---

import type { DtakoDriver, DtakoDailyHoursResponse } from '~/types'

export async function getDtakoDrivers(): Promise<DtakoDriver[]> {
  return request('/api/drivers')
}

export async function getDtakoDailyHours(filter: {
  driver_id?: string
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}): Promise<DtakoDailyHoursResponse> {
  return request(`/api/daily-hours${toParams(filter)}`)
}

// --- 車両分類 ---

export async function getVehicleCategories(): Promise<VehicleCategories> {
  return request<VehicleCategories>('/api/car-inspections/vehicle-categories')
}

/**
 * 電子車検証の管理番号 / 車両 ID で車検期限を照合する (運行者端末の vehicle 段、
 * Refs ippoan/alc-app-s3#110)。**番号を URL (request log) に載せないよう POST**。
 * 404 (未配備) / 403 (kiosk 未許可) / 405 (D が A より先に出た) / ネットワークエラーの
 * どれでも警告を出さず点呼を進めたいので、ここで吸収して null を返す。番号は console に
 * 出さない (simplify-reviewer の検査点)
 */
export async function lookupCarInspection(certNo?: string, carId?: string): Promise<CarInspectionLookupResponse | null> {
  if (!certNo && !carId) return null
  try {
    return await request<CarInspectionLookupResponse>('/api/car-inspections/lookup', {
      method: 'POST',
      body: JSON.stringify({ cert_no: certNo, car_id: carId }),
    })
  } catch {
    console.warn('[CarInspection] lookup failed (警告なしで点呼を進める)')
    return null
  }
}

// --- 日常健康状態 ---

export async function getDailyHealthStatus(date?: string): Promise<DailyHealthResponse> {
  const params = date ? toParams({ date }) : ''
  return request<DailyHealthResponse>(`/api/tenko/daily-health-status${params}`)
}

// --- 指導監督の記録 ---

export async function listGuidanceRecords(filter: {
  employee_id?: string
  guidance_type?: string
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
} = {}): Promise<GuidanceRecordsResponse> {
  return request<GuidanceRecordsResponse>(`/api/guidance-records${toParams(filter)}`)
}

export async function createGuidanceRecord(data: CreateGuidanceRecord): Promise<GuidanceRecord> {
  return request<GuidanceRecord>('/api/guidance-records', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function deleteGuidanceRecord(id: string): Promise<void> {
  await request<void>(`/api/guidance-records/${id}`, { method: 'DELETE' })
}

export async function uploadGuidanceAttachment(recordId: string, file: File): Promise<GuidanceRecordAttachment> {
  // FormData 構築前に未初期化を fail-fast する。Node の undici FormData は append 値の
  // 型検証が厳格 (Node 24 で File を弾くケースあり) なので、proxyRawFetch まで進めると
  // 'API 未初期化' ではなく append エラーで落ちる。proxyRawFetch fallback と同じ条件。
  if (!apiBase && !getAccessToken?.() && !getKioskDeviceJwt) throw new Error('API 未初期化')
  const formData = new FormData()
  formData.append('file', file, file.name)
  const res = await proxyRawFetch(`/api/guidance-records/${recordId}/attachments`, {
    method: 'POST',
    body: formData,
  }, UPLOAD_FETCH_TIMEOUT_MS)
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  return res.json()
}

export async function deleteGuidanceAttachment(recordId: string, attachmentId: string): Promise<void> {
  await request<void>(`/api/guidance-records/${recordId}/attachments/${attachmentId}`, { method: 'DELETE' })
}

// --- 伝達事項 ---

export async function listCommunicationItems(filter: {
  is_active?: boolean
  target_employee_id?: string
  page?: number
  per_page?: number
} = {}): Promise<CommunicationItemsResponse> {
  return request<CommunicationItemsResponse>(`/api/communication-items${toParams(filter)}`)
}

export async function getActiveCommunicationItems(targetEmployeeId?: string): Promise<CommunicationItem[]> {
  const params = targetEmployeeId ? toParams({ target_employee_id: targetEmployeeId }) : ''
  return request<CommunicationItem[]>(`/api/communication-items/active${params}`)
}

export async function createCommunicationItem(data: CreateCommunicationItem): Promise<CommunicationItem> {
  return request<CommunicationItem>('/api/communication-items', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateCommunicationItem(id: string, data: Partial<CommunicationItem>): Promise<CommunicationItem> {
  return request<CommunicationItem>(`/api/communication-items/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteCommunicationItem(id: string): Promise<void> {
  await request<void>(`/api/communication-items/${id}`, { method: 'DELETE' })
}

// --- Hub measurements (CoreS3 統合ハブ、Refs ippoan/rust-alc-api#592) ---

/**
 * CoreS3 ハブ測定の一覧。並びは `created_at DESC` 固定。
 *
 * `from` / `to` は `created_at` に対する閉区間 (端末計時 `recorded_at` は時計未同期で
 * null になり得るため基準に使わない)。`limit` は backend が 1〜200 に clamp し、
 * 実際に適用された値がレスポンスの `limit` に入る。総件数は返らないので、
 * 次ページの有無は `has_more` を見る。
 */
export async function listHubMeasurements(filter: {
  device_id?: string
  kind?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
} = {}): Promise<HubMeasurementsResponse> {
  return request<HubMeasurementsResponse>(`/api/hub/measurements${toParams(filter)}`)
}
