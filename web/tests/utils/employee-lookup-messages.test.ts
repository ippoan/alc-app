import { describe, it, expect } from 'vitest'
import {
  employeeNotFoundByNfc,
  employeeNotFoundByCode,
  noPendingSchedule,
  deviceUnregisteredMessage,
  autoClaimFailedMessage,
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

  it('deviceUnregisteredMessage は未登録であることとペアリングが要ることを言う', () => {
    expect(deviceUnregisteredMessage).toContain('登録されていません')
    expect(deviceUnregisteredMessage).toContain('ペアリング')
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
})
