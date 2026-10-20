import { describe, it, expect } from 'vitest'
import { BP_STATION_DEVICE_AUTH_FAILED_MESSAGE, KIOSK_DEVICE_AUTH_FAILED_MESSAGE } from '~/utils/api'
import {
  employeeNotFoundByNfc,
  employeeNotFoundByCode,
  noPendingSchedule,
  deviceUnregisteredMessage,
  autoClaimFailedMessage,
  employeeLookupFailureMessage,
  failureStatus,
} from '~/utils/employee-lookup-messages'

describe('employee-lookup-messages', () => {
  it('employeeNotFoundByNfc は NFC ID と次の操作 (管理者画面で保存) を含む', () => {
    const msg = employeeNotFoundByNfc('0123ABCD')
    expect(msg).toContain('0123ABCD')
    expect(msg).toContain('保存')
  })

  it('employeeNotFoundByCode は社員番号と次の操作 (確認 / 乗務員登録) を含む', () => {
    const msg = employeeNotFoundByCode('E-42')
    expect(msg).toContain('E-42')
    expect(msg).toContain('乗務員登録')
  })

  it('noPendingSchedule は次の操作 (点呼予定を作成) を含む', () => {
    const msg = noPendingSchedule()
    expect(msg).toContain('未消費の点呼予定がありません')
    expect(msg).toContain('点呼予定を作成')
  })

  it('deviceUnregisteredMessage はまだ使える状態でないことを言う (ペアリングという運用は無い、Refs #238)', () => {
    expect(deviceUnregisteredMessage).toContain('使える状態')
    expect(deviceUnregisteredMessage).not.toContain('ペアリング')
  })

  it('autoClaimFailedMessage は CoreS3 経由であることと理由を含む', () => {
    const msg = autoClaimFailedMessage('http 404')
    expect(msg).toContain('CoreS3')
    expect(msg).toContain('http 404')
  })

  it('autoClaimFailedMessage は ERR AUTH: no key のとき鍵の登録先を案内する', () => {
    const msg = autoClaimFailedMessage('ERR AUTH: no key')
    expect(msg).toContain('鍵が未登録')
    expect(msg).toContain('auth.ippoan.org/device/setup')
    expect(msg).toContain('ERR AUTH: no key')
  })

  describe('employeeLookupFailureMessage / failureStatus (Refs ippoan/alc-app#436)', () => {
    const notFound = '未登録の文言'

    it('404 (.status を持つ Error) のときだけ未登録の文言を返す', () => {
      expect(employeeLookupFailureMessage(Object.assign(new Error('API エラー (404): {}'), { status: 404 }), notFound)).toBe(notFound)
    })

    it('.status が無い Error でも message 先頭の (404): から 404 を読む (createAuthFetch の形)', () => {
      expect(employeeLookupFailureMessage(new Error('API エラー (404): {"error":"employee_not_found"}'), notFound)).toBe(notFound)
    })

    it('端末の鍵の失敗は未登録にせず、その文言をそのまま返す', () => {
      expect(employeeLookupFailureMessage(new Error(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE), notFound)).toBe(BP_STATION_DEVICE_AUTH_FAILED_MESSAGE)
      expect(employeeLookupFailureMessage(new Error(KIOSK_DEVICE_AUTH_FAILED_MESSAGE), notFound)).toBe(KIOSK_DEVICE_AUTH_FAILED_MESSAGE)
    })

    it('404 以外の HTTP エラー (500) も message をそのまま返す', () => {
      const msg = 'API エラー (500): boom'
      expect(employeeLookupFailureMessage(Object.assign(new Error(msg), { status: 500 }), notFound)).toBe(msg)
    })

    it('message が本文中に (404): を含んでも先頭でなければ 404 にしない', () => {
      const msg = 'API エラー (500): upstream said (404): x'
      expect(employeeLookupFailureMessage(new Error(msg), notFound)).toBe(msg)
    })

    it('Error でない値・空の message は汎用文', () => {
      expect(employeeLookupFailureMessage('boom', notFound)).toBe('乗務員の照会に失敗しました')
      expect(employeeLookupFailureMessage(null, notFound)).toBe('乗務員の照会に失敗しました')
      expect(employeeLookupFailureMessage(new Error(''), notFound)).toBe('乗務員の照会に失敗しました')
    })

    it('failureStatus は読めなければ null', () => {
      expect(failureStatus(new Error('通信できません'))).toBeNull()
      expect(failureStatus(undefined)).toBeNull()
    })
  })
})
