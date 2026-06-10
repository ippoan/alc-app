import type {
  ApiMeasurement, ApiEmployee, MeasurementsResponse, MeasurementFilter, MeasurementResult, FaceDataEntry,
  // Tenko
  TenkoSchedule, CreateTenkoSchedule, UpdateTenkoSchedule, TenkoScheduleFilter, TenkoSchedulesResponse,
  TenkoSession, StartTenkoSession, SubmitAlcoholResult, SubmitMedicalData, SubmitSelfDeclaration,
  SubmitDailyInspection, SubmitOperationReport, CancelTenkoSession, InterruptSession, ResumeSession,
  TenkoSessionFilter, TenkoSessionsResponse,
  TenkoRecord, TenkoRecordFilter, TenkoRecordsResponse,
  WebhookConfig, CreateWebhookConfig, WebhookDelivery,
  TenkoDashboard,
  EmployeeHealthBaseline, CreateHealthBaseline, UpdateHealthBaseline,
  EquipmentFailure, CreateEquipmentFailure, UpdateEquipmentFailure, EquipmentFailureFilter, EquipmentFailuresResponse,
  // Timecard
  TimecardCard, CreateTimecardCard, TimePunchWithEmployee, TimePunchFilter, TimePunchesResponse,
  // Device Registration
  Device, DeviceRegistrationRequest, CreateRegistrationResponse, RegistrationStatusResponse,
  ClaimRegistrationRequest, ClaimRegistrationResponse, CreateTokenResponse, CreatePermanentQrResponse, ApproveDeviceResponse,
  DeviceSettingsResponse, CallSchedule,
  DailyHealthResponse, VehicleCategories,
  GuidanceRecord, CreateGuidanceRecord, GuidanceRecordsResponse, GuidanceRecordAttachment,
  CommunicationItem, CreateCommunicationItem, CommunicationItemsResponse,
} from '~/types'

let apiBase = ''
let getAccessToken: (() => string | null) | null = null
let getDeviceTenantId: (() => string | null) | null = null
let tokenRefresher: (() => Promise<void>) | null = null

// 同時リフレッシュ防止用
let refreshPromise: Promise<void> | null = null

export function initApi(
  baseUrl: string,
  tokenGetter?: () => string | null,
  tenantGetter?: () => string | null,
  refresher?: () => Promise<void>,
) {
  apiBase = baseUrl.replace(/\/$/, '')
  getAccessToken = tokenGetter || null
  getDeviceTenantId = tenantGetter || null
  tokenRefresher = refresher || null
}

/** 認証ヘッダーを構築 */
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}

  // JWT 優先
  const token = getAccessToken?.()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
    return headers
  }

  // フォールバック: キオスクモード (X-Tenant-ID)
  const tenantId = getDeviceTenantId?.()
  if (tenantId) {
    headers['X-Tenant-ID'] = tenantId
  }

  return headers
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!apiBase) throw new Error('API 未初期化: initApi() を呼んでください')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(),
    ...(options.headers as Record<string, string> || {}),
  }

  const res = await fetch(`${apiBase}${path}`, { ...options, headers })

  // 401 → トークンリフレッシュ → リトライ (1回のみ)
  if (res.status === 401 && tokenRefresher && getAccessToken?.()) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise

      const retryHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(),
        ...(options.headers as Record<string, string> || {}),
      }
      const retryRes = await fetch(`${apiBase}${path}`, { ...options, headers: retryHeaders })
      if (!retryRes.ok) {
        const body = await retryRes.text().catch(() => '')
        throw new Error(`API エラー (${retryRes.status}): ${body || retryRes.statusText}`)
      }
      if (retryRes.status === 204) return undefined as T
      return retryRes.json()
    } catch {
      // リフレッシュ失敗 → 元のエラーを投げる
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API エラー (${res.status}): ${body || res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
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
    }),
  })
}

/** 測定を開始 (status: started) */
export async function startMeasurement(employeeId: string): Promise<ApiMeasurement> {
  return request<ApiMeasurement>('/api/measurements/start', {
    method: 'POST',
    body: JSON.stringify({ employee_id: employeeId }),
  })
}

/** 測定レコードを更新 */
export async function updateMeasurement(id: string, data: Record<string, unknown>): Promise<ApiMeasurement> {
  return request<ApiMeasurement>(`/api/measurements/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
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

/** NFC IDで乗務員を検索 */
export async function getEmployeeByNfcId(nfcId: string): Promise<ApiEmployee> {
  return request<ApiEmployee>(`/api/employees/by-nfc/${encodeURIComponent(nfcId)}`)
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

/** 全乗務員の顔特徴量を取得 (同期用) */
export async function getFaceData(): Promise<FaceDataEntry[]> {
  return request<FaceDataEntry[]>('/api/employees/face-data')
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

/** 測定の顔写真を取得 (認証付きプロキシ経由) */
export async function fetchFacePhoto(measurementId: string): Promise<string | null> {
  if (!apiBase) return null

  const authHeaders = buildAuthHeaders()
  try {
    const res = await fetch(`${apiBase}/api/measurements/${measurementId}/face-photo`, {
      headers: authHeaders,
      cache: 'no-store',
    })
    if (!res.ok) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

/** 顔写真をアップロード */
export async function uploadFacePhoto(blob: Blob): Promise<string> {
  const formData = new FormData()
  formData.append('file', blob, 'face.jpg')

  if (!apiBase) throw new Error('API 未初期化')

  const authHeaders = buildAuthHeaders()
  const res = await fetch(`${apiBase}/api/upload/face-photo`, {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  })

  if (!res.ok) throw new Error(`アップロード失敗 (${res.status})`)
  const data = await res.json()
  return data.url
}

/** 運行報告の音声をアップロード */
export async function uploadReportAudio(blob: Blob): Promise<string> {
  const formData = new FormData()
  formData.append('file', blob, 'report.webm')

  if (!apiBase) throw new Error('API 未初期化')

  const authHeaders = buildAuthHeaders()
  const res = await fetch(`${apiBase}/api/upload/report-audio`, {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  })

  if (!res.ok) throw new Error(`音声アップロード失敗 (${res.status})`)
  const data = await res.json()
  return data.url
}

export async function uploadBlowVideo(blob: Blob): Promise<string> {
  const formData = new FormData()
  formData.append('file', blob, 'blow.webm')

  if (!apiBase) throw new Error('API 未初期化')

  const authHeaders = buildAuthHeaders()
  const res = await fetch(`${apiBase}/api/upload/blow-video`, {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  })

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
  if (!apiBase) throw new Error('API 未初期化')
  const headers = buildAuthHeaders()
  const res = await fetch(`${apiBase}${path}`, { headers })
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

export async function createSchedule(data: CreateTenkoSchedule): Promise<TenkoSchedule> {
  return request<TenkoSchedule>('/api/tenko/schedules', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function batchCreateSchedules(schedules: CreateTenkoSchedule[]): Promise<TenkoSchedule[]> {
  return request<TenkoSchedule[]>('/api/tenko/schedules/batch', {
    method: 'POST',
    body: JSON.stringify({ schedules }),
  })
}

export async function listSchedules(filter: TenkoScheduleFilter = {}): Promise<TenkoSchedulesResponse> {
  return request<TenkoSchedulesResponse>(`/api/tenko/schedules${toParams(filter)}`)
}

export async function getSchedule(id: string): Promise<TenkoSchedule> {
  return request<TenkoSchedule>(`/api/tenko/schedules/${id}`)
}

export async function updateSchedule(id: string, data: UpdateTenkoSchedule): Promise<TenkoSchedule> {
  return request<TenkoSchedule>(`/api/tenko/schedules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function deleteSchedule(id: string): Promise<void> {
  await request<void>(`/api/tenko/schedules/${id}`, { method: 'DELETE' })
}

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

export async function cancelTenkoSession(sessionId: string, data: CancelTenkoSession): Promise<TenkoSession> {
  return request<TenkoSession>(`/api/tenko/sessions/${sessionId}/cancel`, {
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

// --- レコード ---

export async function listTenkoRecords(filter: TenkoRecordFilter = {}): Promise<TenkoRecordsResponse> {
  return request<TenkoRecordsResponse>(`/api/tenko/records${toParams(filter)}`)
}

export async function getTenkoRecord(id: string): Promise<TenkoRecord> {
  return request<TenkoRecord>(`/api/tenko/records/${id}`)
}

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

export async function getTimecardCardByCardId(cardId: string): Promise<TimecardCard> {
  return request<TimecardCard>(`/api/timecard/cards/by-card/${encodeURIComponent(cardId)}`)
}

export async function punchTimecard(cardId: string, deviceId?: string | null): Promise<TimePunchWithEmployee> {
  return request<TimePunchWithEmployee>('/api/timecard/punch', {
    method: 'POST',
    body: JSON.stringify({ card_id: cardId, device_id: deviceId || undefined }),
  })
}

export async function listTimePunches(filter: TimePunchFilter = {}): Promise<TimePunchesResponse> {
  return request<TimePunchesResponse>(`/api/timecard/punches${toParams(filter)}`)
}

export async function downloadTimePunchesCsv(filter: TimePunchFilter = {}): Promise<void> {
  await downloadCsv(`/api/timecard/punches/csv${toParams(filter)}`, 'time-punches.csv')
}

// ============ Device Registration ============

// 公開API (認証不要)
export async function createDeviceRegistrationRequest(deviceName?: string): Promise<CreateRegistrationResponse> {
  return request<CreateRegistrationResponse>('/api/devices/register/request', {
    method: 'POST',
    body: JSON.stringify({ device_name: deviceName }),
  })
}

export async function checkDeviceRegistrationStatus(code: string): Promise<RegistrationStatusResponse> {
  return request<RegistrationStatusResponse>(`/api/devices/register/status/${code}`)
}

export async function claimDeviceRegistration(data: ClaimRegistrationRequest): Promise<ClaimRegistrationResponse> {
  return request<ClaimRegistrationResponse>('/api/devices/register/claim', {
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
): Promise<void> {
  const body: Record<string, unknown> = { call_enabled: callEnabled, call_schedule: callSchedule }
  if (alwaysOn !== undefined) body.always_on = alwaysOn
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
  if (!apiBase) throw new Error('API 未初期化')
  const formData = new FormData()
  formData.append('file', file, file.name)
  const headers = buildAuthHeaders()
  const res = await fetch(`${apiBase}/api/guidance-records/${recordId}/attachments`, {
    method: 'POST',
    headers,
    body: formData,
  })
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
