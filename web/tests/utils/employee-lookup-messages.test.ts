import { describe, it, expect } from 'vitest'
import {
  employeeNotFoundByNfc,
  employeeNotFoundByCode,
  noPendingSchedule,
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
})
