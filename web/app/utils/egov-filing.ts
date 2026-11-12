import { strFromU8, unzipSync } from 'fflate'
import { FILING_LEAD_DAYS, earliestStartDate, type FilingPartner, type FilingSettings } from '~/utils/tenko-forms'

/**
 * e-Gov の点呼の申請データ (zip) を読み、届出の画面に保存した値と規則の決まりに照らして、出す前 (一時保存) や
 * 出した後 (申請済みの控え) に食い違いを見つける。ブラウザだけで読み、送らない (控えの保存は画面の別のボタン)。
 *
 * 読む手続 (2026-11-12 に到達した 3 件と、受委託の一時保存で確かめた形):
 * - 「各種点呼の届出」(手続 ID 15596A0695000001)
 *   - `…/15596A069500010000_01.xml` 申請基礎情報 (`<西暦>` が申請日)
 *   - `…/15596A069500020000_01.xml` 届出・報告情報 (種別・開始日・営業所 5 件・添付のチェック)
 * - 「輸送の安全に関する業務の管理の受委託の許可」(手続 ID 15596A0478000001)
 *   - `…/15596A047800010000_01.xml` 申請基礎情報
 *   - `…/15596A047800020000_01.xml` 申請内容 (委託者・受託者・期間・添付のチェック)
 * - どちらも `…/kousei.xml` 構成情報 (手続 ID・申請者情報・連絡先情報・提出先・添付ファイル名・法人番号)
 * 書く場所の名前はファイル名の末尾で探す (一時保存と到達で上のフォルダが違ってもよいように)。
 */

/** 申請済みの控えのファイル名 (e-Gov は到達番号で名付ける: 16〜18 桁、末尾 1 字だけ英小文字のことがある) */
export const ARRIVE_FILE = /^(\d{15,17}[0-9a-z])\.zip$/

const FILING_BASE = '15596A069500010000_01.xml'
const FILING_INFO = '15596A069500020000_01.xml'
const ENTRUST_BASE = '15596A047800010000_01.xml'
const ENTRUST_INFO = '15596A047800020000_01.xml'
const KOUSEI = 'kousei.xml'

/** 申請データの手続 (届出 / 受委託の許可 / 読めるが中身を照らさないもの) */
export type EgovProcedure = 'filing' | 'entrust' | 'other'

/** 構成情報の申請者情報・連絡先情報 (無い欄は空) */
export interface EgovPerson {
  name: string
  kana: string
  title: string
  corporation: string
  corporationKana: string
  dept: string
  postalCode: string
  address: string
  addressKana: string
  phone: string
  email: string
}

/** 受委託の委託者・受託者 */
export interface EgovParty {
  name: string
  address: string
  representative: string
  officeName: string
  officeAddress: string
}

/** 受委託の許可申請の申請内容 */
export interface EgovEntrust {
  consignor: EgovParty
  consignee: EgovParty
  /** 開始の予定日・終わりの日 (YYYY-MM-DD)。無ければ空 */
  startDate: string
  endDate: string
  contractChecked: boolean
  detailsChecked: boolean
}

export interface EgovOffice {
  /** 実施 / 被実施 / 実施・被実施両方 (e-Gov の文字のまま) */
  role: string
  otherCompany: string
  name: string
  address: string
  deviceName: string
}

export interface EgovFiling {
  /** 構成情報の手続 ID と手続名称 (無ければ空) */
  procId: string
  procName: string
  procedure: EgovProcedure
  applicant: EgovPerson | null
  contact: EgovPerson | null
  corporateNumber: string
  /** 受委託の許可申請のときだけ */
  entrust: EgovEntrust | null
  /** 申請日 (YYYY-MM-DD)。一時保存などで無ければ空 */
  applyDate: string
  /** 実施 / 変更 / 終了 */
  reportKind: string
  businessType: string
  /** 遠隔点呼 / 事業者間遠隔点呼 / 自動点呼 など (e-Gov の文字のまま) */
  tenkoType: string
  /** 開始日 (YYYY-MM-DD)。無ければ空 */
  startDate: string
  offices: EgovOffice[]
  /** 提出先の支局 (「国土交通省,九州運輸局,長崎運輸支局」の最後の段) */
  destinations: string[]
  attachments: string[]
  pamphletChecked: boolean
  permitChecked: boolean
  complyChecked: boolean
}

export interface EgovFinding {
  level: 'error' | 'warn'
  message: string
}

function pick(zip: Record<string, Uint8Array>, tail: string): Document | null {
  const key = Object.keys(zip).find(k => k === tail || k.endsWith(`/${tail}`))
  return key ? new DOMParser().parseFromString(strFromU8(zip[key]!), 'application/xml') : null
}

const text = (el: Element | Document | null | undefined, tag: string): string =>
  el?.getElementsByTagName(tag)[0]?.textContent ?? ''

/** e-Gov の日付 (2026/12/1・2026/12/01) を YYYY-MM-DD に。読めなければ空 */
export function egovDate(s: string): string {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s.trim())
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : ''
}

function person(el: Element | undefined): EgovPerson | null {
  if (!el) return null
  return {
    name: text(el, '氏名'),
    kana: text(el, '氏名フリガナ'),
    title: text(el, '役職'),
    corporation: text(el, '法人団体名'),
    corporationKana: text(el, '法人団体名フリガナ'),
    dept: text(el, '部門名'),
    postalCode: text(el, '郵便番号'),
    address: text(el, '住所'),
    addressKana: text(el, '住所フリガナ'),
    phone: text(el, '電話番号'),
    email: text(el, '電子メールアドレス'),
  }
}

function party(el: Element | undefined, office: string): EgovParty {
  const o = el?.getElementsByTagName(office)[0]
  return {
    name: text(el, '氏名又は名称'),
    address: text(el, '住所'),
    representative: text(el, '代表者氏名'),
    officeName: text(o, '名称'),
    officeAddress: text(o, '所在地'),
  }
}

/** 申請データの zip を読む。届出・受委託のどちらの申請書も構成情報も無ければ例外 */
export function parseEgovZip(bytes: Uint8Array): EgovFiling {
  const zip = unzipSync(bytes)
  const info = pick(zip, FILING_INFO)
  const entrustInfo = pick(zip, ENTRUST_INFO)
  const kousei = pick(zip, KOUSEI)
  if (!info && !entrustInfo && !kousei) throw new Error('e-Gov の申請データが見つかりません')
  const base = pick(zip, info ? FILING_BASE : ENTRUST_BASE)
  const body = info?.getElementsByTagName('届出報告内容')[0]
  const offices = Array.from(info?.getElementsByTagName('点呼に係る営業所又は車庫情報')[0]?.children ?? [])
    .map(el => ({
      role: text(el, '点呼の実施被実施の別'),
      otherCompany: text(el, '他事業者名'),
      name: text(el, '営業所又は車庫の名称'),
      address: text(el, '営業所又は車庫の位置'),
      deviceName: text(el, '使用する機器の名称'),
    }))
    .filter(o => o.role || o.name || o.address || o.deviceName)
  const all = (doc: Document | null | undefined, tag: string) => Array.from(doc?.getElementsByTagName(tag) ?? []).map(e => String(e.textContent))
  const content = entrustInfo?.getElementsByTagName('申請内容')[0]
  const period = all(entrustInfo, '西暦').map(egovDate)
  const procId = text(kousei, '手続ID')
  return {
    procId,
    procName: text(kousei, '手続名称'),
    procedure: info ? 'filing' : entrustInfo ? 'entrust' : 'other',
    applicant: person(kousei?.getElementsByTagName('申請者情報')[0]),
    contact: person(kousei?.getElementsByTagName('連絡先情報')[0]),
    corporateNumber: text(kousei, '法人番号'),
    entrust: content
      ? {
          consignor: party(content.getElementsByTagName('委託者')[0], '委託営業所'),
          consignee: party(content.getElementsByTagName('受託者')[0], '受託営業所'),
          startDate: period[0] ?? '',
          endDate: period[1] ?? '',
          contractChecked: text(content, '管理の委託受託契約書') === '1',
          detailsChecked: text(content, '管理の報酬その他管理の実施方法の細目を記載した書類') === '1',
        }
      : null,
    applyDate: egovDate(text(base, '西暦')),
    reportKind: text(info, '届出報告種別'),
    businessType: text(body, '事業種別'),
    tenkoType: text(body, '点呼の種別'),
    startDate: egovDate(text(body, '西暦')),
    offices,
    destinations: all(kousei, '提出先名称').map(s => s.split(',').pop()!.trim()),
    attachments: all(kousei, '添付書類ファイル名称').filter(Boolean),
    pamphletChecked: text(info, '点呼機器システムのパンフレット等性能及び機能が確認できる書類') === '1',
    permitChecked: text(info, '事業者間遠隔点呼における管理の受委託に係る許可書') === '1',
    complyChecked: text(info?.getElementsByTagName('遠隔点呼又は事業者間遠隔点呼の場合')[0], '対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します') === '1',
  }
}

const ROLES = ['実施', '被実施', '実施・被実施両方']
const squash = (s: string | null | undefined) => (s ?? '').replace(/[\s　]+/g, '')

/** 所在地の都道府県から、届出を受ける支局の名前にあるはずの語。北海道は支局が 7 つあり決められないので null */
export function bureauStem(address: string): string | null {
  const pref = /^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/.exec(address.trim())?.[1]
  if (!pref || pref === '北海道') return null
  if (pref === '兵庫県') return '神戸'
  return pref.replace(/[都府県]$/, '')
}

type Say = (message: string) => void

/** 比べるための形 (全角英数・ハイフンを半角に、空白を落とす) */
export const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/[\s]+/g, '').replace(/[‐－―−]/g, '-')
/** 数字だけ (郵便番号・電話番号・法人番号) */
const digitsOf = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/\D/g, '')

/** 保存した値が在るときだけ、読んだ値と比べる */
function compare(warn: Say, where: string, label: string, got: string, saved: string | null | undefined, how: (s: string | null | undefined) => string = norm) {
  if (!saved) return
  if (how(got) !== how(saved)) warn(`${where}の「${label}」が「${got || '(空)'}」です。保存した値は「${saved}」`)
}

/** 構成情報の申請者情報・連絡先情報・法人番号を、書き込む値の「届け出る事業者」と比べる */
function checkPeople(f: EgovFiling, s: FilingSettings, warn: Say): void {
  const a = f.applicant
  if (a) {
    const w = '申請者情報'
    compare(warn, w, '法人団体名', a.corporation, s.operator_name)
    compare(warn, w, '法人団体名フリガナ', a.corporationKana, s.operator_kana)
    compare(warn, w, '氏名 (代表者)', a.name, s.operator_representative)
    compare(warn, w, '氏名フリガナ', a.kana, s.operator_representative_kana)
    compare(warn, w, '役職', a.title, s.operator_representative_title)
    compare(warn, w, '郵便番号', a.postalCode, s.operator_postal_code, digitsOf)
    compare(warn, w, '住所', a.address, s.operator_address)
    compare(warn, w, '住所フリガナ', a.addressKana, s.operator_address_kana)
    compare(warn, w, '電話番号', a.phone, s.operator_phone, digitsOf)
  }
  const c = f.contact
  if (c) {
    const w = '連絡先情報'
    compare(warn, w, '氏名', c.name, s.operator_contact_name)
    compare(warn, w, '氏名フリガナ', c.kana, s.operator_contact_kana)
    compare(warn, w, '部門名', c.dept, s.operator_contact_dept)
    compare(warn, w, '郵便番号', c.postalCode, s.operator_contact_postal_code ?? s.operator_postal_code, digitsOf)
    compare(warn, w, '住所', c.address, s.operator_contact_address ?? s.operator_address)
    compare(warn, w, '電話番号', c.phone, s.operator_contact_phone, digitsOf)
    compare(warn, w, '電子メールアドレス', c.email, s.operator_contact_email)
  }
  compare(warn, '構成情報', '法人番号', f.corporateNumber, s.operator_corporate_number, digitsOf)
}

/** 開始日の 2 か月前の日 (YYYY-MM-DD) */
function twoMonthsBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1 - 2, d))
  return t.toISOString().slice(0, 10)
}

/** 開始日から 5 年 (期間の上限) の終わりの日 (YYYY-MM-DD) */
function fiveYearsEnd(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y + 5, m - 1, d - 1)).toISOString().slice(0, 10)
}

/** 受委託の委託者・受託者を、自社 (届け出る事業者・営業所) か相手の会社 (partners) と比べる */
function checkParty(role: string, p: EgovParty, s: FilingSettings, warn: Say): 'self' | 'partner' | 'none' {
  const where = `${role} (${p.name.trim() || '名称なし'})`
  if (s.operator_name && norm(p.name) === norm(s.operator_name)) {
    compare(warn, where, '住所', p.address, s.operator_address)
    compare(warn, where, '代表者氏名', p.representative, s.operator_representative)
    const office = s.offices.find(o => norm(o.name) === norm(p.officeName))
    if (!office) warn(`${where}: 営業所「${p.officeName}」は届出の画面に保存した営業所にありません`)
    else compare(warn, where, '営業所の所在地', p.officeAddress, office.address)
    return 'self'
  }
  const partner: FilingPartner | undefined = s.partners.find(x => norm(x.name) === norm(p.name))
  if (!partner) {
    warn(`${where}: 受委託の相手の会社に保存されていません`)
    return 'none'
  }
  compare(warn, where, '住所', p.address, partner.address)
  compare(warn, where, '代表者氏名', p.representative, partner.representative)
  const office = partner.offices.find(o => norm(o.name) === norm(p.officeName))
  if (!office) warn(`${where}: 営業所「${p.officeName}」は相手の会社に保存した営業所にありません`)
  else compare(warn, where, '営業所の所在地', p.officeAddress, office.address)
  return 'partner'
}

/** 受委託の許可申請の申請内容を照らす */
function checkEntrust(e: EgovEntrust, f: EgovFiling, s: FilingSettings, today: string, err: Say, warn: Say): void {
  const sides = [checkParty('委託者', e.consignor, s, warn), checkParty('受託者', e.consignee, s, warn)]
  if (s.operator_name && !sides.includes('self')) warn('委託者・受託者のどちらも、保存した「届け出る事業者」の名称と合いません')
  if (!e.startDate) err('開始の予定日が入っていません')
  else {
    const by = twoMonthsBefore(e.startDate)
    if ((f.applyDate || today) > by) warn(`開始の予定日 ${e.startDate} の 2 か月前 (${by}) を過ぎています (通達は開始の 2 か月前までの申請)`)
    if (!e.endDate) err('期間の終わりの日が入っていません')
    else if (e.endDate > fiveYearsEnd(e.startDate)) err(`期間が 5 年を超えています (${e.startDate} 〜 ${e.endDate})`)
  }
  if (!e.contractChecked) err('「管理の委託受託契約書」の添付にチェックがありません')
  if (!e.detailsChecked) err('「管理の報酬その他管理の実施方法の細目を記載した書類」の添付にチェックがありません')
  if (!f.attachments.length) warn('添付ファイルがまだ付いていません (契約書・細目・自己点検表)')
}

/** 申請データを、届出の画面に保存した値と規則の決まりに照らす。食い違いが無ければ空 */
export function checkEgovFiling(f: EgovFiling, s: FilingSettings, today: string): EgovFinding[] {
  const out: EgovFinding[] = []
  const err: Say = message => out.push({ level: 'error', message })
  const warn: Say = message => out.push({ level: 'warn', message })
  if (f.procedure === 'filing') checkFilingInfo(f, s, today, err, warn)
  if (f.entrust) checkEntrust(f.entrust, f, s, today, err, warn)
  checkPeople(f, s, warn)
  return out
}

/** 書き込む値の空の欄だけ、申請データで読んだ値で埋めた写し (受委託の相手の会社は無ければ足す) */
export function fillSettingsFromFiling(f: EgovFiling, s: FilingSettings): FilingSettings {
  const next: FilingSettings = { ...s, partners: s.partners.map(p => ({ ...p, offices: [...p.offices] })) }
  const fill = <K extends keyof FilingSettings>(key: K, v: string) => {
    if (!next[key] && v.trim()) (next[key] as string | null) = v.trim()
  }
  const a = f.applicant
  if (a) {
    fill('operator_name', a.corporation)
    fill('operator_kana', a.corporationKana)
    fill('operator_representative', a.name)
    fill('operator_representative_kana', a.kana)
    fill('operator_representative_title', a.title)
    fill('operator_postal_code', digitsOf(a.postalCode))
    fill('operator_address', a.address)
    fill('operator_address_kana', a.addressKana)
    fill('operator_phone', a.phone)
  }
  const c = f.contact
  if (c) {
    fill('operator_contact_name', c.name)
    fill('operator_contact_kana', c.kana)
    fill('operator_contact_dept', c.dept)
    fill('operator_contact_phone', c.phone)
    fill('operator_contact_email', c.email)
    if (digitsOf(c.postalCode) !== digitsOf(next.operator_postal_code)) fill('operator_contact_postal_code', digitsOf(c.postalCode))
    if (norm(c.address) !== norm(next.operator_address)) fill('operator_contact_address', c.address)
  }
  fill('operator_corporate_number', digitsOf(f.corporateNumber))
  for (const p of f.entrust ? [f.entrust.consignor, f.entrust.consignee] : []) {
    if (!p.name.trim() || norm(p.name) === norm(next.operator_name)) continue
    let partner = next.partners.find(x => norm(x.name) === norm(p.name))
    if (!partner) {
      partner = { name: p.name.trim(), address: p.address.trim() || null, representative: p.representative.trim() || null, offices: [] }
      next.partners.push(partner)
    }
    if (p.officeName.trim() && !partner.offices.some(o => norm(o.name) === norm(p.officeName))) {
      partner.offices.push({ name: p.officeName.trim(), address: p.officeAddress.trim() || null })
    }
  }
  return next
}

/** 各種点呼の届出の届出・報告情報を照らす */
function checkFilingInfo(f: EgovFiling, s: FilingSettings, today: string, err: Say, warn: Say): void {
  const remote = f.tenkoType === '遠隔点呼' || f.tenkoType === '事業者間遠隔点呼'
  const starting = f.reportKind === '実施'

  if (!f.offices.length) err('点呼に係る営業所・車庫が 1 件も入っていません')
  for (const [i, o] of f.offices.entries()) {
    const at = `申請 ${i + 1} 件目 (${o.name.trim() || '名称なし'})`
    if (o.name !== o.name.trim() || o.address !== o.address.trim()) warn(`${at}: 名称か所在地の前後に空白があります`)
    if (s.device_name && o.deviceName !== s.device_name) {
      err(`${at}: 使用する機器の名称が「${o.deviceName}」です。届出の画面の「${s.device_name}」をコピーして貼ってください`)
    }
    const saved = s.offices.find(x => squash(x.name) === squash(o.name))
    if (!saved) {
      warn(`${at}: 届出の画面に保存した営業所にありません`)
      continue
    }
    if (squash(saved.address) !== squash(o.address)) warn(`${at}: 所在地が保存した「${saved.address ?? ''}」と違います`)
    if (ROLES[saved.role - 1] !== o.role) warn(`${at}: 実施・被実施の別が保存した「${ROLES[saved.role - 1] ?? ''}」と違います`)
  }

  if (starting) {
    const min = earliestStartDate(f.applyDate || today)
    if (!f.startDate) err('開始日が入っていません')
    else if (f.startDate < min) err(`開始日 ${f.startDate} は申請日の ${FILING_LEAD_DAYS} 日後 (${min}) より前です`)
  }

  if (remote && starting) {
    if (!f.pamphletChecked) err('#67 点呼機器のパンフレットの「添付しました」にチェックがありません')
    if (!f.attachments.some(a => a.startsWith('67_'))) err('#67 点呼機器のパンフレットのファイル (名前の先頭が 67_) が添付されていません')
  }
  if (remote && f.reportKind !== '終了' && !f.complyChecked) err('#69 告示の要件を遵守する宣誓にチェックがありません')
  if (f.tenkoType === '事業者間遠隔点呼' && f.reportKind !== '終了') {
    if (!f.permitChecked || !f.attachments.some(a => a.startsWith('68_'))) {
      err('#68 管理の受委託の許可書 (名前の先頭が 68_) が添付されていません')
    }
    if (!f.offices.some(o => o.otherCompany.trim())) err('事業者間遠隔点呼なのに、#18 他事業者名がどの営業所にも入っていません')
  }

  const stems = f.offices.map(o => bureauStem(o.address))
  for (const d of f.destinations) {
    if (stems.includes(null)) break
    if (!stems.some(st => d.includes(st!))) warn(`提出先の「${d}」は、どの営業所の所在地の支局とも合いません`)
  }
}
