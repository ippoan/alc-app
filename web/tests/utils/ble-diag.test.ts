// 診断の置き場に残す BLE の行の判定 (体温計・血圧計)。測定値は type だけにして残す
import { describe, it, expect } from 'vitest'
import { bleDiagJson, isBleDiagEvent } from '~/utils/ble-diag'

describe('ble-diag', () => {
  it.each([
    'EVT THERMO_CONN try',
    'EVT OMRON_CONN try',
    'EVT OMRON_ENC ok retry=1',
    'EVT BP_BOND saved',
    'EVT BLE_SCAN_OK',
  ])('残す EVT 行 (%s)', (line) => {
    expect(isBleDiagEvent(line)).toBe(true)
  })

  it.each(['EVT NFC_READY', 'EVT GPS NOFIX', 'EVT THERMO'])('残さない EVT 行 (%s)', (line) => {
    expect(isBleDiagEvent(line)).toBe(false)
  })

  it('体温計・血圧計の状態の JSON はそのまま残す', () => {
    for (const line of [
      '{"type":"found","device":"thermometer"}',
      '{"type":"connected","device":"blood_pressure"}',
      '{"type":"disconnected","device":"blood_pressure"}',
    ]) expect(bleDiagJson(line)).toBe(line)
  })

  it('★ 測定値の JSON は値を落として type だけにする', () => {
    expect(bleDiagJson('{"type":"blood_pressure","systolic":125,"diastolic":77,"pulse":69,"unit":"mmHg"}'))
      .toBe('{"type":"blood_pressure"}')
    expect(bleDiagJson('{"type":"temperature","value":36.5,"unit":"celsius"}')).toBe('{"type":"temperature"}')
  })

  it('error は message の先頭が体温計か血圧計のときだけ残す', () => {
    expect(bleDiagJson('{"type":"error","message":"thermometer: connection failed"}')).not.toBeNull()
    expect(bleDiagJson('{"type":"error","message":"blood_pressure: connection failed"}')).not.toBeNull()
    expect(bleDiagJson('{"type":"error","message":"nfc: read failed"}')).toBeNull()
    expect(bleDiagJson('{"type":"error"}')).toBeNull()
  })

  it('他の JSON と読めない行は残さない', () => {
    expect(bleDiagJson('{"type":"found","device":"nfc"}')).toBeNull()
    expect(bleDiagJson('{"type":"reset","message":"Scan restarted"}')).toBeNull()
    expect(bleDiagJson('{broken')).toBeNull()
  })
})
