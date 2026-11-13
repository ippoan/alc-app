// 受委託の契約書の差し込み。値は架空。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  BUREAU_NAMES, CONTRACT_TEMPLATE_PATH, bureauOf, buildContract, contractDate, contractOfficeName, contractValues, defaultOffice, fiveYearsEnd,
  fillContract, missingContractFields, type ContractRequest,
} from '~/utils/consignment-contract'
import { emptySettings, type FilingSettings } from '~/utils/tenko-forms'

function settings(over: Partial<FilingSettings>): FilingSettings {
  return { ...emptySettings(), ...over }
}

const REQ: ContractRequest = {
  kou: {
    settings: settings({
      operator_name: '架空運輸株式会社', operator_postal_code: '999-0001', operator_address: '長崎県架空市1-1',
      operator_representative_title: '代表取締役', operator_representative: '架空　太郎',
    }),
    office: '本社営業所',
  },
  otsu: {
    settings: settings({ operator_name: 'A&B<物流>', operator_address: '福岡県架空市2-2', operator_representative: '架空　花子' }),
    office: '港営業所',
  },
  validFrom: '2027-02-01',
  validTo: '2032-01-31',
  contractDate: '2026-11-12',
  bureau: '九州運輸局長',
}

const TEMPLATE = new Uint8Array(readFileSync(resolve(import.meta.dirname, '../../public/forms/tenko-consignment-contract.docx')))

function body(docx: Uint8Array): string {
  return strFromU8(unzipSync(docx)['word/document.xml']!)
}

function fakeDocx(xml: string | null): Uint8Array {
  return zipSync(xml === null ? { 'x.xml': strToU8('') } : { 'word/document.xml': strToU8(xml) })
}

describe('契約書の書き方', () => {
  it('日付は令和で、1 桁は全角・2 桁は半角。読めない・平成以前は空欄', () => {
    expect(contractDate('2027-02-01')).toBe('令和９年２月１日')
    expect(contractDate('2032-01-31')).toBe('令和14年１月31日')
    expect(contractDate('2026-11-12')).toBe('令和８年11月12日')
    expect(contractDate('')).toBe('令和　　年　　月　　日')
    expect(contractDate('2018-12-31')).toBe('令和　　年　　月　　日')
  })

  it('5 年の終了日は開始日の 5 年後の前日。月をまたいでも繰り下げ、うるう日は 2 月 28 日まで。読めなければ空', () => {
    expect(fiveYearsEnd('2027-02-01')).toBe('2032-01-31')
    expect(fiveYearsEnd('2027-01-01')).toBe('2031-12-31')
    expect(fiveYearsEnd('2028-02-29')).toBe('2033-02-28')
    expect(fiveYearsEnd('')).toBe('')
  })

  it('営業所は括弧書きを落とし、営業所で終わらなければ足す', () => {
    expect(contractOfficeName('本社 (長崎)')).toBe('本社営業所')
    expect(contractOfficeName('本社（長崎）')).toBe('本社営業所')
    expect(contractOfficeName('釧路営業所')).toBe('釧路営業所')
    expect(contractOfficeName('本社')).toBe('本社営業所')
  })

  it('既定の営業所は本社、無ければ先頭', () => {
    expect(defaultOffice([{ name: '港営業所' }, { name: '本社' }])).toEqual({ name: '本社' })
    expect(defaultOffice([{ name: '港営業所' }])).toEqual({ name: '港営業所' })
    expect(defaultOffice([])).toBeUndefined()
  })

  it('運輸局長は住所の都道府県から。郵便番号は飛ばし、読めなければ空', () => {
    expect(bureauOf('〒856-0044　長崎県大村市')).toBe('九州運輸局長')
    expect(bureauOf('北海道釧路市')).toBe('北海道運輸局長')
    expect(bureauOf('沖縄県那覇市')).toBe('沖縄総合事務局長')
    expect(bureauOf('架空県')).toBe('')
    expect(bureauOf(null)).toBe('')
    expect(bureauOf(undefined)).toBe('')
    expect(BUREAU_NAMES).toHaveLength(10)
  })

  it('目印ごとの値。郵便番号・役職が無ければ付けない', () => {
    expect(contractValues(REQ)).toEqual({
      KOU_NAME: '架空運輸株式会社',
      OTSU_NAME: 'A&B<物流>',
      KOU_ADDRESS: '〒999-0001　長崎県架空市1-1',
      OTSU_ADDRESS: '福岡県架空市2-2',
      KOU_REPRESENTATIVE: '代表取締役　架空　太郎',
      OTSU_REPRESENTATIVE: '架空　花子',
      KOU_OFFICE: '本社営業所',
      OTSU_OFFICE: '港営業所',
      VALID_FROM: '令和９年２月１日',
      VALID_TO: '令和14年１月31日',
      CONTRACT_DATE: '令和８年11月12日',
      BUREAU: '九州運輸局長',
    })
    const blank = contractValues({ ...REQ, otsu: { settings: emptySettings(), office: '' } })
    expect([blank.OTSU_NAME, blank.OTSU_ADDRESS, blank.OTSU_REPRESENTATIVE]).toEqual(['', '', ''])
  })

  it('足りない値を甲・乙の別を付けて挙げる', () => {
    expect(missingContractFields(REQ)).toEqual([])
    expect(missingContractFields({ ...REQ, kou: { settings: emptySettings(), office: '' } }))
      .toEqual(['甲の名称', '甲の住所', '甲の代表者氏名'])
  })
})

describe('雛形への差し込み', () => {
  it('同梱の雛形の目印を全部置き換え、記号は XML の文字参照にする', () => {
    const xml = body(fillContract(TEMPLATE, REQ))
    expect(xml).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(xml).toContain('架空運輸株式会社（以下「甲」という。）及びA&amp;B&lt;物流&gt;（以下「乙」という。）')
    expect(xml).toContain('甲の本社営業所（以下「甲営業所」という。）')
    expect(xml).toContain('乙の港営業所（以下「乙営業所」という。）')
    expect(xml).toContain('令和９年２月１日から令和14年１月31日までとする')
    expect(xml).toContain('乙は九州運輸局長の許可')
    expect(xml).toContain('〒999-0001　長崎県架空市1-1')
    expect(xml).toContain('代表取締役　架空　太郎')
    expect(xml).toContain('令和８年11月12日')
  })

  it('雛形に作成者の氏名を残さない', () => {
    const core = strFromU8(unzipSync(TEMPLATE)['docProps/core.xml']!)
    expect(core).toContain('<dc:creator></dc:creator>')
    expect(core).toContain('<cp:lastModifiedBy></cp:lastModifiedBy>')
  })

  it('本文が無い・目印が欠ける・知らない目印が残るなら例外', () => {
    expect(() => fillContract(fakeDocx(null), REQ)).toThrow('契約書の雛形の本文が見つかりません')
    expect(() => fillContract(fakeDocx('<x/>'), REQ)).toThrow('契約書の雛形に {{KOU_NAME}} がありません')
    const all = Object.keys(contractValues(REQ)).map(k => `{{${k}}}`).join('')
    expect(() => fillContract(fakeDocx(`${all}{{EXTRA}}`), REQ)).toThrow('契約書の雛形に置き換えていない {{EXTRA}} があります')
  })

  it('雛形を取ってファイル名を付ける。名称が無ければ未設定と書き、取れなければ例外', async () => {
    const fetcher = vi.fn(async () => new Response(TEMPLATE as BlobPart))
    const out = await buildContract(REQ, fetcher as unknown as typeof fetch)
    expect(fetcher).toHaveBeenCalledWith(CONTRACT_TEMPLATE_PATH, { cache: 'no-store' })
    expect(out.filename).toBe('委託受託契約書_委託架空運輸株式会社_受託A&B<物流>.docx')
    expect(body(out.bytes)).toContain('架空運輸株式会社')
    const blank = await buildContract({ ...REQ, kou: { settings: emptySettings(), office: '' } }, fetcher as unknown as typeof fetch)
    expect(blank.filename).toBe('委託受託契約書_委託名称未設定_受託A&B<物流>.docx')
    const bad = vi.fn(async () => new Response('', { status: 404 }))
    await expect(buildContract(REQ, bad as unknown as typeof fetch)).rejects.toThrow('契約書の雛形を取得できませんでした (404)')
  })

  it('既定の取得は fetch を使う', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(TEMPLATE as BlobPart))
    await buildContract(REQ)
    expect(spy).toHaveBeenCalledWith(CONTRACT_TEMPLATE_PATH, { cache: 'no-store' })
    spy.mockRestore()
  })
})
