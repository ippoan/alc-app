/**
 * API テスト用の共通データ定義
 *
 * mock テスト (api.test.ts) と integration テスト (api-live.test.ts) の両方で使用。
 * スキーマ変更時はここだけ修正すれば両方のテストに反映される。
 */

// ---------------------------------------------------------------------------
// IDs (seed.sql と一致)
// ---------------------------------------------------------------------------
export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111'
export const TEST_USER_ID = '22222222-2222-2222-2222-222222222222'
export const TEST_EMPLOYEE_ID = '33333333-3333-3333-3333-333333333333'

// Seed resource IDs (seed.sql で作成済み — live で GET しても 404 にならない)
export const SEED_MEASUREMENT_ID = 'aaaaaaaa-0001-0001-0001-aaaaaaaaaaaa'
export const SEED_SCHEDULE_ID = 'aaaaaaaa-0002-0002-0002-aaaaaaaaaaaa'
export const SEED_SESSION_ID = 'aaaaaaaa-0003-0003-0003-aaaaaaaaaaaa'
export const SEED_RECORD_ID = 'aaaaaaaa-0004-0004-0004-aaaaaaaaaaaa'
export const SEED_WEBHOOK_ID = 'aaaaaaaa-0005-0005-0005-aaaaaaaaaaaa'
export const SEED_FAILURE_ID = 'aaaaaaaa-0006-0006-0006-aaaaaaaaaaaa'
export const SEED_DEVICE_ID = 'aaaaaaaa-0007-0007-0007-aaaaaaaaaaaa'
export const SEED_TIMECARD_CARD_ID = 'aaaaaaaa-0008-0008-0008-aaaaaaaaaaaa'
export const SEED_CARRYING_ITEM_ID = 'aaaaaaaa-0009-0009-0009-aaaaaaaaaaaa'
export const SEED_COMM_ITEM_ID = 'aaaaaaaa-000a-000a-000a-aaaaaaaaaaaa'
export const SEED_GUIDANCE_ID = 'aaaaaaaa-000b-000b-000b-aaaaaaaaaaaa'
export const SEED_REG_CODE = 'SEED-CODE'
export const SEED_NFC_ID = 'NFC-SEED-001'

// Disposable IDs for DELETE tests (seed.sql dddddddd-* prefix)
export const DEL_EMPLOYEE_ID = 'dddddddd-0001-0001-0001-dddddddddddd'
export const DEL_SCHEDULE_ID = 'dddddddd-0002-0002-0002-dddddddddddd'
export const DEL_WEBHOOK_ID = 'dddddddd-0005-0005-0005-dddddddddddd'
export const DEL_TIMECARD_ID = 'dddddddd-0008-0008-0008-dddddddddddd'
export const DEL_DEVICE_ID = 'dddddddd-0007-0007-0007-dddddddddddd'
export const DEL_CARRYING_ID = 'dddddddd-0009-0009-0009-dddddddddddd'
export const DEL_GUIDANCE_ID = 'dddddddd-000b-000b-000b-dddddddddddd'
export const DEL_COMM_ID = 'dddddddd-000a-000a-000a-dddddddddddd'

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
export const JWT_SECRET = 'test-jwt-secret-for-integration'

// ---------------------------------------------------------------------------
// Request bodies (実 API が受け付ける正しいフィールド名)
// ---------------------------------------------------------------------------

export const createScheduleBody = {
  employee_id: TEST_EMPLOYEE_ID,
  tenko_type: 'pre_operation',
  responsible_manager_name: 'Test Manager',
  scheduled_at: new Date().toISOString(),
  instruction: 'Test instruction',
}

export const createEquipmentFailureBody = {
  failure_type: 'manual_report',
  description: 'Test failure',
}

export const createWebhookBody = {
  url: 'https://example.com/webhook',
  event_type: 'tenko_completed',
}

export const createCarryingItemBody = {
  item_name: 'Test Item',
}

export const createGuidanceRecordBody = {
  employee_id: TEST_EMPLOYEE_ID,
  title: 'Test Guidance',
  content: 'Test guidance content',
}

export const createCommunicationItemBody = {
  title: 'Test Notice',
  content: 'Test content',
}

export const createHealthBaselineBody = {
  employee_id: TEST_EMPLOYEE_ID,
  baseline_systolic: 120,
  baseline_diastolic: 80,
  baseline_temperature: 36.5,
}

export const createTimecardCardBody = {
  card_id: 'NFC-TEST-CARD-001',
  employee_id: TEST_EMPLOYEE_ID,
}

export const startTenkoSessionBody = {
  employee_id: TEST_EMPLOYEE_ID,
  tenko_type: 'pre_operation',
}

export const createEmployeeBody = {
  name: 'New Driver',
  code: 'E999',
}
