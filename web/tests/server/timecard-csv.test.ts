// 打刻の CSV の「デバイス」列だけを名前に替える純粋ロジック (Refs ippoan/alc-cam#2)。
// 他の列・列の位置・BOM・改行・引用符は変えないことを固定する。値は合成
import { describe, it, expect } from 'vitest'
import { DEVICE_COLUMN_HEADER, renameDeviceColumn } from '../../server/utils/timecard-csv'

const HEADER = 'ID,区分,カード,社員コード,社員名,打刻日時,デバイス,測定ID,アルコール値,判定,点呼記録'
const row = (id: string, device: string, name = '山田') => `${id},打刻,ICカード,001,${name},2026-10-24 09:00:00,${device},,,,`
const upper = (v: string) => `<${v}>`

describe('renameDeviceColumn', () => {
  it('デバイス列だけ替える。BOM・ヘッダー・他の列・改行はそのまま', () => {
    const csv = `﻿${HEADER}\n${row('1', 'alarm:a')}\n${row('2', 'browser')}\n`
    expect(renameDeviceColumn(csv, upper)).toBe(`﻿${HEADER}\n${row('1', '<alarm:a>')}\n${row('2', '<browser>')}\n`)
    expect(DEVICE_COLUMN_HEADER).toBe('デバイス')
  })

  it('空のデバイス (端末の記録が無い打刻) は替えない', () => {
    const csv = `${HEADER}\n${row('1', '')}\n`
    expect(renameDeviceColumn(csv, upper)).toBe(csv)
  })

  it('他の欄の引用符・欄内の改行とカンマは触らず、名前にカンマ・引用符があれば引用符を付ける', () => {
    const csv = `${HEADER}\r\n${row('1', 'k', '"山田, 太郎"')}\r\n"2",打刻,IC,001,"a\nb",2026-10-24 09:00:00,"x""y",,,,\r\n`
    const out = renameDeviceColumn(csv, id => (id === 'k' ? '事務所, 1 階' : 'say "hi"'))
    expect(out).toBe(`${HEADER}\r\n${row('1', '"事務所, 1 階"', '"山田, 太郎"')}\r\n"2",打刻,IC,001,"a\nb",2026-10-24 09:00:00,"say ""hi""",,,,\r\n`)
  })

  it('最終行に改行が無くても保つ。BOM が無い CSV もそのまま扱う', () => {
    expect(renameDeviceColumn(`${HEADER}\n${row('1', 'a')}`, upper)).toBe(`${HEADER}\n${row('1', '<a>')}`)
  })

  it('列が足りない短い行は触らない', () => {
    const csv = `${HEADER}\nshort,row\n`
    expect(renameDeviceColumn(csv, upper)).toBe(csv)
  })

  it('ヘッダーにデバイス列が無い・空の CSV は何も替えずそのまま返す', () => {
    const csv = 'ID,名前\n1,a\n'
    expect(renameDeviceColumn(csv, upper)).toBe(csv)
    expect(renameDeviceColumn('', upper)).toBe('')
    expect(renameDeviceColumn('﻿', upper)).toBe('﻿')
  })

  it('ヘッダーが引用符付きでも列を見つける', () => {
    expect(renameDeviceColumn('"ID","デバイス"\n1,a\n', upper)).toBe('"ID","デバイス"\n1,<a>\n')
  })
})
