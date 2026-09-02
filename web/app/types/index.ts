/** 顔認証結果 */
export interface FaceAuthResult {
  verified: boolean
  similarity: number
  snapshot?: Blob
}

/** 測定結果 */
export interface MeasurementResult {
  employeeId: string
  alcoholValue: number
  resultType: 'normal' | 'over' | 'error'
  deviceUseCount: number
  facePhotoUrl?: string
  videoUrl?: string
  measuredAt: Date
  // Medical data (BLE Medical Gateway)
  temperature?: number
  systolic?: number
  diastolic?: number
  pulse?: number
  medicalMeasuredAt?: Date
}

/** NFC 読み取りイベント */
export interface NfcReadEvent {
  type: 'nfc_read'
  employee_id: string
}

/** NFC 免許証読み取りイベント */
export interface NfcLicenseReadEvent {
  type: 'nfc_license_read'
  card_id: string
  card_type: 'driver_license' | 'car_inspection' | 'other'
  atr: string
  expiry_date?: string
  remain_count?: number
  felica_uid?: string
}

/** NFC デバッグイベント (APDU ステップログ) */
export interface NfcDebugEvent {
  type: 'nfc_debug'
  message: string
}

/** NFC エラーイベント */
export interface NfcErrorEvent {
  type: 'nfc_error'
  error: string
}

/** NFC ステータスイベント */
export interface NfcStatusEvent {
  type: 'status'
  readers: string[]
  connected: boolean
  version?: string
}

export type NfcEvent = NfcReadEvent | NfcErrorEvent

/** NFC WebSocket イベント (全種別) */
export type NfcWebSocketEvent = NfcReadEvent | NfcLicenseReadEvent | NfcDebugEvent | NfcErrorEvent | NfcStatusEvent

/** FC-1200 測定状態 */
export type Fc1200State =
  | 'idle'
  | 'waiting_connection'
  | 'connected'
  | 'warming_up'
  | 'blow_waiting'
  | 'measuring'
  | 'result_received'

/** FC-1200 WASM イベント (feed() が返す JSON 配列の要素) */
export interface Fc1200Event {
  type: 'state_changed' | 'measurement_result' | 'usage_time' | 'memory_data' | 'date_update_response' | 'error' | 'connected' | 'status' | 'permission_requested'
  from?: string
  to?: Fc1200State
  alcohol_value?: number
  result_type?: 'normal' | 'over' | 'error'
  use_count?: number
  error_code?: string
  message?: string
  // usage_time (RQUT)
  total_seconds?: number
  elapsed_days?: number
  // memory_data (RQDD)
  id?: string
  datetime?: string
  // date_update_response
  success?: boolean
}

/** FC-1200 センサ寿命情報 */
export interface SensorLifetime {
  totalSeconds: number
  elapsedDays: number
}

/** FC-1200 メモリデータ */
export interface MemoryRecord {
  id: string
  datetime: string
  alcoholValue: number
}

/** 顔 embedding レコード */
export interface FaceRecord {
  employeeId: string
  descriptor: Float32Array
  updatedAt: number
  approvalStatus?: 'pending' | 'approved' | 'rejected'
  modelVersion?: string
}

/** API: 測定結果 (サーバー側) */
export interface ApiMeasurement {
  id: string
  tenant_id: string
  employee_id: string
  alcohol_value: number | null
  result_type: string | null
  device_use_count: number
  face_photo_url?: string
  video_url?: string | null
  measured_at: string
  created_at: string
  updated_at: string
  status: 'started' | 'completed'
  face_verified?: boolean | null
  // Medical data (BLE Medical Gateway)
  temperature?: number | null
  systolic?: number | null
  diastolic?: number | null
  pulse?: number | null
  medical_measured_at?: string | null
  medical_manual_input?: boolean | null
}

/** API: 乗務員 */
export interface ApiEmployee {
  id: string
  tenant_id: string
  code?: string | null
  nfc_id?: string | null
  name: string
  face_photo_url?: string | null
  face_embedding_at?: string | null
  face_approval_status?: 'none' | 'pending' | 'approved' | 'rejected'
  face_approved_at?: string | null
  license_issue_date?: string | null
  license_expiry_date?: string | null
  role: Array<'driver' | 'manager' | 'admin'>
  created_at: string
  updated_at: string
}

/** 顔特徴量同期用データ */
export interface FaceDataEntry {
  id: string
  face_embedding: number[]
  face_embedding_at: string
  face_model_version?: string
  face_approval_status: string
}

/** API: 測定結果一覧レスポンス */
export interface MeasurementsResponse {
  measurements: ApiMeasurement[]
  total: number
  page: number
  per_page: number
}

/** API: 測定フィルタ */
export interface MeasurementFilter {
  employee_id?: string
  result_type?: 'normal' | 'over' | 'error'
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
  status?: string
}

/** 認証ユーザー */
export interface AuthUser {
  id: string
  email: string
  name: string
  tenant_id: string
  role: 'admin' | 'viewer'
}

/** ログインレスポンス */
export interface AuthResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: AuthUser
}

/** リフレッシュレスポンス */
export interface RefreshResponse {
  access_token: string
  expires_in: number
}

/** シグナリングメッセージ (クライアント → サーバー) */
export interface SignalingOutMessage {
  type: 'sdp_offer' | 'sdp_answer' | 'ice_candidate' | 'ping'
  sdp?: string
  candidate?: RTCIceCandidateInit
}

/** シグナリングメッセージ (サーバー → クライアント) */
export interface SignalingInMessage {
  type: 'sdp_offer' | 'sdp_answer' | 'ice_candidate' | 'peer_joined' | 'peer_left' | 'error' | 'pong'
  sdp?: string
  candidate?: RTCIceCandidateInit
  role?: 'device' | 'admin'
  message?: string
}

// --- BLE Medical Gateway ---

/** BLE Medical Gateway デバイス種別 */
export type BleDeviceType = 'thermometer' | 'blood_pressure'

/** 体温測定結果 */
export interface TemperatureReading {
  value: number
  unit: 'celsius'
  measuredAt: Date
}

/** 血圧測定結果 */
export interface BloodPressureReading {
  systolic: number
  diastolic: number
  pulse?: number
  unit: 'mmHg'
  measuredAt: Date
}

/** BLE Gateway から受信する JSON メッセージ */
export type BleGatewayMessage =
  | { type: 'ready'; device: string; version: string }
  | { type: 'scan'; name: string; address: string; rssi: number }
  | { type: 'found'; device: BleDeviceType }
  | { type: 'connecting'; device: BleDeviceType }
  | { type: 'connected'; device: BleDeviceType }
  | { type: 'disconnected'; device: BleDeviceType }
  | { type: 'temperature'; value: number; unit: 'celsius' }
  | { type: 'blood_pressure'; systolic: number; diastolic: number; pulse?: number; unit: 'mmHg' }
  | { type: 'error'; message: string }
  | { type: 'heartbeat'; uptime: number; thermo: boolean; bp: boolean }
  | { type: 'reset'; message: string }

// --- 自動点呼 (Tenko) ---

export type TenkoType = 'pre_operation' | 'post_operation'

export type TenkoSessionStatus =
  | 'identity_verified'
  | 'alcohol_testing'
  | 'medical_pending'
  | 'self_declaration_pending'
  | 'safety_judgment_pending'
  | 'daily_inspection_pending'
  | 'carrying_items_pending'
  | 'instruction_pending'
  | 'report_pending'
  | 'interrupted'
  | 'completed'
  | 'cancelled'

/** 点呼スケジュール */
export interface TenkoSchedule {
  id: string
  tenant_id: string
  employee_id: string
  tenko_type: TenkoType
  responsible_manager_name: string
  scheduled_at: string
  instruction: string | null
  consumed: boolean
  consumed_by_session_id: string | null
  overdue_notified_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateTenkoSchedule {
  employee_id: string
  tenko_type: TenkoType
  responsible_manager_name: string
  scheduled_at: string
  instruction?: string
}

export interface UpdateTenkoSchedule {
  responsible_manager_name?: string
  scheduled_at?: string
  instruction?: string
}

export interface TenkoScheduleFilter {
  employee_id?: string
  tenko_type?: TenkoType
  consumed?: boolean
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface TenkoSchedulesResponse {
  schedules: TenkoSchedule[]
  total: number
  page: number
  per_page: number
}

/** 自己申告 (JSONB) */
export interface SelfDeclaration {
  illness: boolean
  fatigue: boolean
  sleep_deprivation: boolean
  declared_at: string
}

/** 医療差分 */
export interface MedicalDiffs {
  systolic_diff: number | null
  diastolic_diff: number | null
  temperature_diff: number | null
}

/** 安全判定 (JSONB) */
export interface SafetyJudgment {
  status: string
  failed_items: string[]
  judged_at: string
  medical_diffs: MedicalDiffs | null
}

/** 日常点検 (JSONB) */
export interface DailyInspection {
  brakes: string
  tires: string
  lights: string
  steering: string
  wipers: string
  mirrors: string
  horn: string
  seatbelts: string
  inspected_at: string
}

/** 点呼セッション */
export interface TenkoSession {
  id: string
  tenant_id: string
  employee_id: string
  schedule_id: string | null
  tenko_type: TenkoType
  status: TenkoSessionStatus
  identity_verified_at: string | null
  identity_face_photo_url: string | null
  measurement_id: string | null
  alcohol_result: string | null
  alcohol_value: number | null
  alcohol_tested_at: string | null
  alcohol_face_photo_url: string | null
  temperature: number | null
  systolic: number | null
  diastolic: number | null
  pulse: number | null
  medical_measured_at: string | null
  medical_manual_input: boolean | null
  instruction_confirmed_at: string | null
  report_vehicle_road_status: string | null
  report_driver_alternation: string | null
  report_no_report: boolean | null
  report_submitted_at: string | null
  location: string | null
  responsible_manager_name: string | null
  cancel_reason: string | null
  interrupted_at: string | null
  resumed_at: string | null
  resume_reason: string | null
  resumed_by_user_id: string | null
  self_declaration: SelfDeclaration | null
  safety_judgment: SafetyJudgment | null
  daily_inspection: DailyInspection | null
  carrying_items_checked: CarryingItemsChecked | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface StartTenkoSession {
  schedule_id?: string          // remote mode では省略
  tenko_type?: TenkoType        // schedule なしの場合に使用
  employee_id: string
  identity_face_photo_url?: string
  location?: string
}

export interface SubmitAlcoholResult {
  measurement_id?: string
  alcohol_result: string
  alcohol_value: number
  alcohol_face_photo_url?: string
}

export interface SubmitMedicalData {
  temperature?: number
  systolic?: number
  diastolic?: number
  pulse?: number
  medical_measured_at?: string
  medical_manual_input?: boolean
}

export interface SubmitSelfDeclaration {
  illness: boolean
  fatigue: boolean
  sleep_deprivation: boolean
}

export interface SubmitDailyInspection {
  brakes: string
  tires: string
  lights: string
  steering: string
  wipers: string
  mirrors: string
  horn: string
  seatbelts: string
}

export interface SubmitOperationReport {
  vehicle_road_status: string
  driver_alternation: string
  vehicle_road_audio_url?: string
  driver_alternation_audio_url?: string
}

export interface CancelTenkoSession {
  reason: string
}

export interface InterruptSession {
  reason?: string
}

export interface ResumeSession {
  reason: string
}

export interface TenkoSessionFilter {
  employee_id?: string
  status?: string
  tenko_type?: TenkoType
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface TenkoSessionsResponse {
  sessions: TenkoSession[]
  total: number
  page: number
  per_page: number
}

/** 点呼記録 (不変アーカイブ) */
export interface TenkoRecord {
  id: string
  tenant_id: string
  session_id: string
  employee_id: string
  tenko_type: TenkoType
  status: string
  record_data: unknown
  employee_name: string
  responsible_manager_name: string
  tenko_method: string
  location: string | null
  alcohol_result: string | null
  alcohol_value: number | null
  alcohol_has_face_photo: boolean
  temperature: number | null
  systolic: number | null
  diastolic: number | null
  pulse: number | null
  instruction: string | null
  instruction_confirmed_at: string | null
  report_vehicle_road_status: string | null
  report_driver_alternation: string | null
  report_no_report: boolean | null
  started_at: string | null
  completed_at: string | null
  recorded_at: string
  record_hash: string
  self_declaration: SelfDeclaration | null
  safety_judgment: SafetyJudgment | null
  daily_inspection: DailyInspection | null
  interrupted_at: string | null
  resumed_at: string | null
  resume_reason: string | null
}

export interface TenkoRecordFilter {
  employee_id?: string
  tenko_type?: TenkoType
  status?: string
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface TenkoRecordsResponse {
  records: TenkoRecord[]
  total: number
  page: number
  per_page: number
}

/** Webhook 設定 */
export interface WebhookConfig {
  id: string
  tenant_id: string
  event_type: string
  url: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CreateWebhookConfig {
  event_type: string
  url: string
  secret?: string
  enabled?: boolean
}

/** Webhook 配信履歴 */
export interface WebhookDelivery {
  id: string
  tenant_id: string
  config_id: string
  event_type: string
  payload: unknown
  status_code: number | null
  response_body: string | null
  attempt: number
  delivered_at: string | null
  created_at: string
  success: boolean
}

/** 点呼ダッシュボード集計 */
export interface TenkoDashboard {
  pending_schedules: number
  active_sessions: number
  interrupted_sessions: number
  completed_today: number
  cancelled_today: number
  overdue_schedules: TenkoSchedule[]
}

/** 健康基準値 */
export interface EmployeeHealthBaseline {
  id: string
  tenant_id: string
  employee_id: string
  baseline_systolic: number
  baseline_diastolic: number
  baseline_temperature: number
  systolic_tolerance: number
  diastolic_tolerance: number
  temperature_tolerance: number
  measurement_validity_minutes: number
  created_at: string
  updated_at: string
}

export interface CreateHealthBaseline {
  employee_id: string
  baseline_systolic?: number
  baseline_diastolic?: number
  baseline_temperature?: number
  systolic_tolerance?: number
  diastolic_tolerance?: number
  temperature_tolerance?: number
  measurement_validity_minutes?: number
}

export interface UpdateHealthBaseline {
  baseline_systolic?: number
  baseline_diastolic?: number
  baseline_temperature?: number
  systolic_tolerance?: number
  diastolic_tolerance?: number
  temperature_tolerance?: number
  measurement_validity_minutes?: number
}

/** 機器故障記録 */
export interface EquipmentFailure {
  id: string
  tenant_id: string
  failure_type: string
  description: string
  affected_device: string | null
  detected_at: string
  detected_by: string | null
  resolved_at: string | null
  resolution_notes: string | null
  session_id: string | null
  created_at: string
  updated_at: string
}

export interface CreateEquipmentFailure {
  failure_type: string
  description: string
  affected_device?: string
  detected_at?: string
  detected_by?: string
  session_id?: string
}

export interface UpdateEquipmentFailure {
  resolution_notes?: string
}

export interface EquipmentFailureFilter {
  failure_type?: string
  resolved?: boolean
  session_id?: string
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface EquipmentFailuresResponse {
  failures: EquipmentFailure[]
  total: number
  page: number
  per_page: number
}

// --- タイムカード ---

export interface TimecardCard {
  id: string
  tenant_id: string
  employee_id: string
  card_id: string
  label?: string
  created_at: string
}

export interface CreateTimecardCard {
  employee_id: string
  card_id: string
  label?: string
}

export interface TimePunch {
  id: string
  tenant_id: string
  employee_id: string
  device_id?: string
  device_name?: string
  employee_name?: string
  punched_at: string
  created_at: string
}

export interface TimePunchWithEmployee {
  punch: TimePunch
  employee_name: string
  today_punches: TimePunch[]
}

export interface TimePunchFilter {
  employee_id?: string
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface TimePunchesResponse {
  punches: TimePunch[]
  total: number
  page: number
  per_page: number
}

// --- 車両分類 ---

export interface VehicleCategories {
  car_kinds: string[]
  uses: string[]
  car_shapes: string[]
  private_businesses: string[]
}

// --- 日常健康状態 ---

export interface DailyHealthRow {
  employee_id: string
  employee_name: string
  employee_code: string | null
  session_id: string | null
  tenko_type: string | null
  completed_at: string | null
  temperature: number | null
  systolic: number | null
  diastolic: number | null
  pulse: number | null
  medical_measured_at: string | null
  medical_manual_input: boolean | null
  alcohol_result: string | null
  alcohol_value: number | null
  self_declaration: SelfDeclaration | null
  safety_judgment: SafetyJudgment | null
  has_baseline: boolean | null
  baseline_systolic: number | null
  baseline_diastolic: number | null
  baseline_temperature: number | null
  systolic_tolerance: number | null
  diastolic_tolerance: number | null
  temperature_tolerance: number | null
}

export interface DailyHealthSummary {
  total_employees: number
  checked_count: number
  unchecked_count: number
  pass_count: number
  fail_count: number
}

export interface DailyHealthResponse {
  date: string
  employees: DailyHealthRow[]
  summary: DailyHealthSummary
}

// --- Device Registration ---

export type DeviceFlowType = 'qr_temp' | 'qr_permanent' | 'url'
export type DeviceStatus = 'active' | 'disabled'
export type RegistrationStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface CallSchedule {
  enabled: boolean
  startHour: number
  startMin: number
  endHour: number
  endMin: number
  days: number[]
}

export interface Device {
  id: string
  tenant_id: string
  device_name: string
  device_type: 'kiosk' | 'android'
  phone_number?: string
  user_id?: string
  status: DeviceStatus
  approved_by?: string
  approved_at?: string
  last_seen_at?: string
  call_enabled: boolean
  call_schedule?: CallSchedule | null
  fcm_token?: string | null
  last_login_employee_id?: string | null
  last_login_employee_name?: string | null
  last_login_employee_role?: string[] | null
  app_version_code?: number | null
  app_version_name?: string | null
  is_device_owner: boolean
  is_dev_device: boolean
  always_on: boolean
  watchdog_running?: boolean | null
  created_at: string
  updated_at: string
  /** re-pair (再認証) 状態。管理者が開けた時限 window の期限 (Refs rust-alc-api#495) */
  re_pair_authorized_until?: string | null
  last_re_pair_at?: string | null
  re_pair_count: number
  hardware_id?: string | null
}

export interface DeviceSettingsResponse {
  call_enabled: boolean
  call_schedule?: CallSchedule | null
  status: string
  last_login_employee_id?: string | null
  last_login_employee_name?: string | null
  last_login_employee_role?: string[] | null
  always_on: boolean
}

export interface DeviceRegistrationRequest {
  id: string
  registration_code: string
  flow_type: DeviceFlowType
  tenant_id?: string
  phone_number?: string
  device_name: string
  status: RegistrationStatus
  device_id?: string
  expires_at?: string
  is_device_owner?: boolean
  is_dev_device?: boolean
  created_at: string
}

export interface CreateRegistrationResponse {
  registration_code: string
  expires_at: string
}

export interface RegistrationStatusResponse {
  status: RegistrationStatus
  device_id?: string
  tenant_id?: string
  device_name?: string
  /** 承認時に発行される device 保有 token (approved 時のみ、Refs rust-alc-api#388) */
  settings_token?: string
  /** 承認時に発行される kiosk device credential (approved 時のみ、Refs rust-alc-api#480) */
  auth_device_id?: string
  device_secret?: string
}

export interface ClaimRegistrationRequest {
  registration_code: string
  phone_number?: string
  device_name?: string
}

export interface ClaimRegistrationResponse {
  success: boolean
  flow_type: DeviceFlowType
  device_id?: string
  tenant_id?: string
  message?: string
  /** 即時登録フローで発行される device 保有 token (Refs rust-alc-api#388) */
  settings_token?: string
  /** 即時登録フローで発行される kiosk device credential (Refs rust-alc-api#480) */
  auth_device_id?: string
  device_secret?: string
}

export interface CreateTokenResponse {
  registration_code: string
  registration_url: string
}

export interface CreatePermanentQrResponse {
  registration_code: string
}

export interface ApproveDeviceResponse {
  success: boolean
  device_id: string
  tenant_id: string
}

// --- 再認証 (re-pair、Refs rust-alc-api#495) ---

export interface AuthorizeRepairResponse {
  authorized_until: string
}

export interface RePairRequest {
  device_id: string
  hardware_id?: string
  settings_token?: string
}

export interface RePairResponse {
  auth_device_id: string
  device_secret: string
}

// --- 携行品 ---

export interface VehicleCondition {
  id: string
  carrying_item_id: string
  category: string
  value: string
}

export interface VehicleConditionInput {
  category: string
  value: string
}

export interface CarryingItem {
  id: string
  tenant_id: string
  item_name: string
  is_required: boolean
  sort_order: number
  created_at: string
  vehicle_conditions: VehicleCondition[]
}

export interface CreateCarryingItem {
  item_name: string
  is_required?: boolean
  sort_order?: number
  vehicle_conditions?: VehicleConditionInput[]
}

export interface UpdateCarryingItem {
  item_name?: string
  is_required?: boolean
  sort_order?: number
  vehicle_conditions?: VehicleConditionInput[]
}

export interface CarryingItemCheckInput {
  item_id: string
  checked: boolean
}

export interface CarryingItemsChecked {
  items: Array<{
    item_id: string
    item_name: string
    checked: boolean
  }>
  checked_at: string
}

// --- 指導監督の記録 ---

export interface GuidanceRecordAttachment {
  id: string
  record_id: string
  file_name: string
  file_type: string
  file_size: number | null
  storage_url: string
  created_at: string
}

export interface GuidanceRecord {
  id: string
  tenant_id: string
  employee_id: string
  employee_name?: string
  guidance_type: string
  title: string
  content: string
  guided_by: string | null
  guided_at: string
  parent_id: string | null
  depth: number
  children?: GuidanceRecord[]
  attachments?: GuidanceRecordAttachment[]
  created_at: string
  updated_at: string
}

export interface CreateGuidanceRecord {
  employee_id: string
  guidance_type?: string
  title: string
  content?: string
  guided_by?: string
  guided_at?: string
  parent_id?: string | null
}

export interface GuidanceRecordsResponse {
  records: GuidanceRecord[]
  total: number
  page: number
  per_page: number
}

// --- 伝達事項 ---

export interface CommunicationItem {
  id: string
  tenant_id: string
  title: string
  content: string
  priority: string
  target_employee_id: string | null
  target_employee_name?: string | null
  is_active: boolean
  effective_from: string | null
  effective_until: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateCommunicationItem {
  title: string
  content?: string
  priority?: string
  target_employee_id?: string | null
  effective_from?: string | null
  effective_until?: string | null
  created_by?: string
}

export interface CommunicationItemsResponse {
  items: CommunicationItem[]
  total: number
  page: number
  per_page: number
}

// --- 運転者情報パネル ---

export interface DriverInfo {
  // イ 健康状態
  health_baseline: EmployeeHealthBaseline | null
  recent_measurements: Array<{
    id: string
    temperature: number | null
    systolic: number | null
    diastolic: number | null
    pulse: number | null
    measured_at: string | null
  }>
  // ロ 労働時間
  working_hours: Array<{
    id: string
    driver_id: string
    work_date: string
    start_time: string
    total_work_minutes: number | null
    total_drive_minutes: number | null
    total_rest_minutes: number | null
    late_night_minutes: number
    drive_minutes: number
    cargo_minutes: number
  }>
  // ハ 指導監督の記録
  past_instructions: Array<{
    session_id: string
    instruction: string
    instruction_confirmed_at: string | null
    recorded_at: string
  }>
  // ニ 携行品
  carrying_items: CarryingItem[]
  // ホ 乗務員台帳
  employee: ApiEmployee
  // ヘ 過去の点呼記録
  past_tenko_records: TenkoRecord[]
  // ト 車両整備状況
  recent_daily_inspections: Array<{
    session_id: string
    daily_inspection: DailyInspection
    recorded_at: string
  }>
  equipment_failures: EquipmentFailure[]
}

// --- 労働時間 (dtako) ---

export interface DtakoDriver {
  id: string
  tenant_id: string
  driver_cd: string | null
  driver_name: string
}

export interface DtakoDailyWorkHours {
  id: string
  tenant_id: string
  driver_id: string
  work_date: string
  start_time: string
  total_work_minutes: number | null
  total_drive_minutes: number | null
  total_rest_minutes: number | null
  late_night_minutes: number
  drive_minutes: number
  cargo_minutes: number
  overlap_drive_minutes: number
  overlap_cargo_minutes: number
  overlap_break_minutes: number
  overlap_restraint_minutes: number
  ot_late_night_minutes: number
  total_distance: number | null
  operation_count: number
  unko_nos: string[] | null
  created_at: string
  updated_at: string
}

export interface DtakoDailyHoursResponse {
  items: DtakoDailyWorkHours[]
  total: number
  page: number
  per_page: number
}

// --- Hub measurements (CoreS3 統合ハブ、Refs ippoan/rust-alc-api#592) ---

/** `GET /api/hub/measurements` の 1 行。`payload` は JSONB 素通し (kind 別の型付けは別 issue)。 */
export interface HubMeasurement {
  id: string
  tenant_id: string
  device_id: string
  /** temperature / blood_pressure / alcohol / fc1200_raw */
  kind: string
  payload: unknown
  seq: number
  /** 端末計時。時計未同期端末では null */
  recorded_at: string | null
  /** サーバ受信時刻。一覧の並び順・期間絞り込みはこの列が基準 */
  created_at: string
}

/**
 * `GET /api/hub/measurements` のレスポンス。
 * 総件数は返らない (ingest テーブルが伸び続けるため) ので、次ページの有無は
 * `has_more` で判断する。
 */
export interface HubMeasurementsResponse {
  items: HubMeasurement[]
  /** 実際に適用された limit (backend で clamp 済み) */
  limit: number
  offset: number
  has_more: boolean
}

/** 受理される測定種別 (backend の HUB_MEASUREMENT_KINDS と一致。allowlist 外は 400)。 */
export const HUB_MEASUREMENT_KINDS = ['temperature', 'blood_pressure', 'alcohol', 'fc1200_raw'] as const

// ============================================================
// Driver master sync (theearth 乗務員マスタ → alc employees、Refs ippoan/alc-app-s3#125)
// ============================================================

/** 1 comp (theearth の会社) 分の同期結果。`status` は relay が DO から受けた HTTP status。 */
export interface DriverMasterSyncCompResult {
  comp_id: string
  status: number
  created?: number | null
  updated?: number | null
  skipped?: Array<{ code: string; reason: string }>
  error?: string
}

/** `POST /api/driver-master/run` (same-origin server route) の応答。 */
export interface DriverMasterSyncResult {
  results: DriverMasterSyncCompResult[]
}

// --- ts-rs 自動生成型 (Rust backend → TypeScript) ---
// `cargo test -p alc-core --features ts-export --test export_ts` で再生成
// 段階的に手動型からの移行を進める。まずは Backend prefix 付きで参照可能にする。
export * as Backend from './generated'
