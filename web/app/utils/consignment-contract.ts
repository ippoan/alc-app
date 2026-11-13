import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { FilingSettings } from './tenko-forms'

/**
 * 事業者間遠隔点呼の受委託の契約書 (業務の管理の委託受託契約書) に値を差し込む (管理画面の「点呼の届出」タブ)。
 *
 * 雛形は `public/forms/tenko-consignment-contract.docx` (31 契約書) と `tenko-consignment-saimoku.docx` (32 実施方法の細目)。
 * 国の様式ではなく自前の文案なので tenko-forms ではなくここに置く。受委託は相互なので、甲乙を入れ替えた 2 組を 1 つの zip にする。
 * 本文の差し込む位置に `{{KOU_NAME}}` などの目印が 1 つの run に収まって入っている。ブラウザで目印を置き換えて
 * そのまま保存させる。サーバーには送らない。
 */

export const CONTRACT_TEMPLATE_PATH = '/forms/tenko-consignment-contract.docx'
export const SAIMOKU_TEMPLATE_PATH = '/forms/tenko-consignment-saimoku.docx'

/** 細目に入る目印 (期間・営業所・運輸局長は無い) */
const SAIMOKU_KEYS = ['KOU_NAME', 'OTSU_NAME', 'KOU_ADDRESS', 'OTSU_ADDRESS', 'KOU_REPRESENTATIVE', 'OTSU_REPRESENTATIVE', 'CONTRACT_DATE']

/** 契約の一方 (甲 = 委託者、乙 = 受託者) */
export interface ContractParty {
  settings: FilingSettings
  /** 契約書に書く営業所の名前 (本社営業所 など) */
  office: string
}

export interface ContractRequest {
  kou: ContractParty
  otsu: ContractParty
  /** YYYY-MM-DD */
  validFrom: string
  validTo: string
  contractDate: string
  /** 延長の許可をする行政庁 (九州運輸局長 など) */
  bureau: string
}

/** 1 桁は全角・2 桁以上は半角 (契約書の書き方。令和９年２月１日 / 令和14年１月31日) */
function jaNumber(n: number): string {
  return n < 10 ? String.fromCharCode(0xFF10 + n) : String(n)
}

/** 令和 n 年 m 月 d 日。読めなければ空欄 (令和　　年　　月　　日) */
export function contractDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m || Number(m[1]) < 2019) return '令和　　年　　月　　日'
  return `令和${jaNumber(Number(m[1]) - 2018)}年${jaNumber(Number(m[2]))}月${jaNumber(Number(m[3]))}日`
}

/**
 * 開始日から 5 年の期間の終了日 (開始日の 5 年後の前日。2027-02-01 → 2032-01-31)。
 * 受委託の許可は 5 年未満なので、終了日は開始日 + 5 年より前にする。読めなければ空
 */
export function fiveYearsEnd(from: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from)
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]) + 5, Number(m[2]) - 1, Number(m[3]) - 1))
  return d.toISOString().slice(0, 10)
}

/** 営業所の名前を契約書の書き方にする (後ろの括弧書きを落とし、営業所で終わらなければ足す) */
export function contractOfficeName(name: string): string {
  const base = name.replace(/\s*[（(][^（()）]*[)）]\s*$/, '').trim()
  return base.endsWith('営業所') ? base : `${base}営業所`
}

/** 本社の営業所 (名前に「本社」を含む最初のもの)。無ければ先頭 */
export function defaultOffice<T extends { name: string }>(offices: T[]): T | undefined {
  return offices.find(o => o.name.includes('本社')) ?? offices[0]
}

const BUREAUS: [string, string[]][] = [
  ['北海道運輸局長', ['北海道']],
  ['東北運輸局長', ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県']],
  ['関東運輸局長', ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '山梨県']],
  ['北陸信越運輸局長', ['新潟県', '富山県', '石川県', '長野県']],
  ['中部運輸局長', ['福井県', '岐阜県', '静岡県', '愛知県', '三重県']],
  ['近畿運輸局長', ['滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県']],
  ['中国運輸局長', ['鳥取県', '島根県', '岡山県', '広島県', '山口県']],
  ['四国運輸局長', ['徳島県', '香川県', '愛媛県', '高知県']],
  ['九州運輸局長', ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県']],
  ['沖縄総合事務局長', ['沖縄県']],
]

/** 延長の許可をする行政庁の選択肢 */
export const BUREAU_NAMES: string[] = BUREAUS.map(([name]) => name)

/** 住所の都道府県から管轄の運輸局長を引く。読めなければ空 */
export function bureauOf(address: string | null | undefined): string {
  const a = (address ?? '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').trim()
  return BUREAUS.find(([, prefs]) => prefs.some(p => a.startsWith(p)))?.[0] ?? ''
}

function partyAddress(s: FilingSettings): string {
  return [s.operator_postal_code ? `〒${s.operator_postal_code}` : '', s.operator_address ?? ''].filter(Boolean).join('　')
}

function partyRepresentative(s: FilingSettings): string {
  return [s.operator_representative_title ?? '', s.operator_representative ?? ''].filter(Boolean).join('　')
}

/** 契約書に要るのに「書き込む値」に入っていない欄 (甲・乙の別を付けた見出し) */
export function missingContractFields(req: ContractRequest): string[] {
  const out: string[] = []
  for (const [label, p] of [['甲', req.kou], ['乙', req.otsu]] as const) {
    if (!p.settings.operator_name) out.push(`${label}の名称`)
    if (!p.settings.operator_address) out.push(`${label}の住所`)
    if (!p.settings.operator_representative) out.push(`${label}の代表者氏名`)
  }
  return out
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 目印と書く値 */
export function contractValues(req: ContractRequest): Record<string, string> {
  return {
    KOU_NAME: req.kou.settings.operator_name ?? '',
    OTSU_NAME: req.otsu.settings.operator_name ?? '',
    KOU_ADDRESS: partyAddress(req.kou.settings),
    OTSU_ADDRESS: partyAddress(req.otsu.settings),
    KOU_REPRESENTATIVE: partyRepresentative(req.kou.settings),
    OTSU_REPRESENTATIVE: partyRepresentative(req.otsu.settings),
    KOU_OFFICE: req.kou.office,
    OTSU_OFFICE: req.otsu.office,
    VALID_FROM: contractDate(req.validFrom),
    VALID_TO: contractDate(req.validTo),
    CONTRACT_DATE: contractDate(req.contractDate),
    BUREAU: req.bureau,
  }
}

/** 雛形の目印 (keys) を置き換える。雛形に無い目印・置き換え残しがあれば例外 (雛形と食い違い) */
export function fillContract(file: Uint8Array, req: ContractRequest, keys?: string[]): Uint8Array {
  const zip = unzipSync(file)
  const path = 'word/document.xml'
  if (!zip[path]) throw new Error('契約書の雛形の本文が見つかりません')
  let xml = strFromU8(zip[path]!)
  const values = contractValues(req)
  for (const key of keys ?? Object.keys(values)) {
    const value = values[key]!
    const mark = `{{${key}}}`
    if (!xml.includes(mark)) throw new Error(`契約書の雛形に ${mark} がありません`)
    xml = xml.split(mark).join(escapeXml(value))
  }
  const left = /\{\{[A-Z_]+\}\}/.exec(xml)
  if (left) throw new Error(`契約書の雛形に置き換えていない ${left[0]} があります`)
  zip[path] = strToU8(xml)
  return zipSync(zip, { level: 6 })
}

/** 甲乙を入れ替えた受委託 (延長を許可する運輸局長は、新しい乙の管轄) */
export function reverseRequest(req: ContractRequest, bureau: string): ContractRequest {
  return { ...req, kou: req.otsu, otsu: req.kou, bureau }
}

async function fetchTemplate(path: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const res = await fetcher(path, { cache: 'no-store' })
  if (!res.ok) throw new Error(`契約書の雛形を取得できませんでした (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

function nameOf(p: ContractParty): string {
  return p.settings.operator_name || '名称未設定'
}

/**
 * 相互の受委託の契約書と細目を 1 つの zip にする。A = req の向き、B = 甲乙を入れ替えた向き (運輸局長は reverseBureau)。
 * 各組に 31 契約書・32 実施方法の細目を入れる
 */
export async function buildContracts(req: ContractRequest, reverseBureau: string, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array, filename: string }> {
  const [contract, saimoku] = await Promise.all([fetchTemplate(CONTRACT_TEMPLATE_PATH, fetcher), fetchTemplate(SAIMOKU_TEMPLATE_PATH, fetcher)])
  const files: Record<string, Uint8Array> = {}
  for (const [label, r] of [['A', req], ['B', reverseRequest(req, reverseBureau)]] as const) {
    const dir = `${label}_委託${nameOf(r.kou)}_受託${nameOf(r.otsu)}`
    files[`${dir}/31_管理の委託受託契約書.docx`] = fillContract(contract, r)
    files[`${dir}/32_管理の報酬その他管理の実施方法の細目を記載した書類.docx`] = fillContract(saimoku, r, SAIMOKU_KEYS)
  }
  return { bytes: zipSync(files), filename: `受委託契約書_${nameOf(req.kou)}_${nameOf(req.otsu)}.zip` }
}
