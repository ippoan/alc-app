import { strFromU8, unzipSync } from 'fflate'
import { FILING_LEAD_DAYS, earliestStartDate, type FilingSettings } from '~/utils/tenko-forms'

/**
 * e-Gov の「各種点呼の届出」(手続 ID 15596A0695000001) の申請データ (zip) を読み、届出の画面に保存した値と
 * 規則の決まりに照らして、出す前 (一時保存) や出した後 (到達) に食い違いを見つける。ブラウザだけで読み、送らない。
 *
 * zip の中身 (2026-11-12 に到達した 3 件で確かめた形):
 * - `…/15596A069500010000_01.xml` 申請基礎情報 (`<西暦>` が申請日)
 * - `…/15596A069500020000_01.xml` 届出・報告情報 (種別・開始日・営業所 5 件・添付のチェック)
 * - `…/kousei.xml` 構成情報 (提出先・添付ファイル名)
 * 書く場所の名前はファイル名の末尾で探す (一時保存と到達で上のフォルダが違ってもよいように)。
 */

const BASE_INFO = '15596A069500010000_01.xml'
const FILING_INFO = '15596A069500020000_01.xml'
const KOUSEI = 'kousei.xml'

export interface EgovOffice {
  /** 実施 / 被実施 / 実施・被実施両方 (e-Gov の文字のまま) */
  role: string
  otherCompany: string
  name: string
  address: string
  deviceName: string
}

export interface EgovFiling {
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

/** 申請データの zip を読む。届出・報告情報が無ければ例外 */
export function parseEgovZip(bytes: Uint8Array): EgovFiling {
  const zip = unzipSync(bytes)
  const info = pick(zip, FILING_INFO)
  if (!info) throw new Error('e-Gov の点呼の届出の申請データが見つかりません')
  const base = pick(zip, BASE_INFO)
  const kousei = pick(zip, KOUSEI)
  const body = info.getElementsByTagName('届出報告内容')[0]
  const offices = Array.from(info.getElementsByTagName('点呼に係る営業所又は車庫情報')[0]?.children ?? [])
    .map(el => ({
      role: text(el, '点呼の実施被実施の別'),
      otherCompany: text(el, '他事業者名'),
      name: text(el, '営業所又は車庫の名称'),
      address: text(el, '営業所又は車庫の位置'),
      deviceName: text(el, '使用する機器の名称'),
    }))
    .filter(o => o.role || o.name || o.address || o.deviceName)
  const all = (doc: Document | null, tag: string) => Array.from(doc?.getElementsByTagName(tag) ?? []).map(e => String(e.textContent))
  return {
    applyDate: egovDate(text(base, '西暦')),
    reportKind: text(info, '届出報告種別'),
    businessType: text(body, '事業種別'),
    tenkoType: text(body, '点呼の種別'),
    startDate: egovDate(text(body, '西暦')),
    offices,
    destinations: all(kousei, '提出先名称').map(s => s.split(',').pop()!.trim()),
    attachments: all(kousei, '添付書類ファイル名称'),
    pamphletChecked: text(info, '点呼機器システムのパンフレット等性能及び機能が確認できる書類') === '1',
    permitChecked: text(info, '事業者間遠隔点呼における管理の受委託に係る許可書') === '1',
    complyChecked: text(info.getElementsByTagName('遠隔点呼又は事業者間遠隔点呼の場合')[0], '対面による点呼と同等の効果を有するものとして国土交通大臣が定める方法を定める告示に規定されている要件を遵守します') === '1',
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

/** 申請データを、届出の画面に保存した値と規則の決まりに照らす。食い違いが無ければ空 */
export function checkEgovFiling(f: EgovFiling, s: FilingSettings, today: string): EgovFinding[] {
  const out: EgovFinding[] = []
  const err = (message: string) => out.push({ level: 'error', message })
  const warn = (message: string) => out.push({ level: 'warn', message })
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
  return out
}
