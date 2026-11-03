import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/**
 * 点呼の届出・自動点呼機器の認定申請の様式に値を差し込む (管理画面の「点呼の届出」タブ)。
 *
 * 様式の原本は ippoan/tenko-forms (public)。`manifest.json` の `forms.<id>.latest` が最新版のパスで、
 * 毎週月曜に取り直される。ブラウザで raw を取り、xlsx / docx (どちらも zip の中の XML) の決まった位置に
 * 値を書いて、そのままダウンロードさせる。サーバーには送らない。
 *
 * 書く位置は様式ごとの対応表 ({@link EGOV_CELLS}・{@link fillBessi7}・{@link fillYoshiki1}・{@link fillYoshiki2}) に持つ。
 * docx には差し込み用の目印が無いので、本文の何番目の段落・表の何行何列かで指す。様式の版が変わって
 * 位置がずれたら、ここを直す (位置の文字を確かめ、合わなければ書かずに例外にする)。
 */

export const TENKO_FORMS_RAW = 'https://raw.githubusercontent.com/ippoan/tenko-forms/main/'

/** 点呼に係る営業所又は車庫。`role` は 1 実施 / 2 被実施 / 3 実施・被実施両方 */
export interface FilingOffice {
  name: string
  address: string | null
  role: number
}

/** テナントに保存する値 (`/api/tenko/filing-settings`) */
export interface FilingSettings {
  business_number: string | null
  trade_name: string | null
  business_type: number | null
  offices: FilingOffice[]
  device_name: string | null
  auto_cert_pre: string | null
  auto_cert_post: string | null
  operator_name: string | null
  operator_address: string | null
  operator_representative: string | null
  operator_contact_name: string | null
  operator_contact_phone: string | null
  operator_contact_email: string | null
  applicant_name: string | null
  applicant_kana: string | null
  applicant_address: string | null
  applicant_contact_name: string | null
  applicant_contact_dept: string | null
  applicant_contact_phone: string | null
  applicant_contact_email: string | null
  product_url: string | null
  updated_at?: string | null
}

/** 点呼の種別 (参考様式 #13 のうち、一歩庵点呼で届け出るもの) */
export type FilingKind = 'remote' | 'auto'

/** ダウンロードのたびに決める値 (保存しない) */
export interface FilingRequest {
  kind: FilingKind
  /** 申請日 (YYYY-MM-DD) */
  applyDate: string
  /** 実施予定日 (YYYY-MM-DD)。空なら書かない */
  startDate: string
}

export const BUSINESS_TYPES = [
  '一般貨物', '特定貨物', '貨物軽', '特定第二種貨物', '一般乗合', '一般貸切', '一般乗用', '特定旅客',
] as const

export const OFFICE_ROLES = ['実施', '被実施', '実施・被実施両方'] as const

/** 参考様式の申請欄の件数 (#17〜#51 の 5 件) */
export const EGOV_OFFICE_SLOTS = 5

export function emptySettings(): FilingSettings {
  return {
    business_number: null,
    trade_name: null,
    business_type: null,
    offices: [],
    device_name: '一歩庵点呼 v1',
    auto_cert_pre: null,
    auto_cert_post: null,
    operator_name: null,
    operator_address: null,
    operator_representative: null,
    operator_contact_name: null,
    operator_contact_phone: null,
    operator_contact_email: null,
    applicant_name: null,
    applicant_kana: null,
    applicant_address: null,
    applicant_contact_name: null,
    applicant_contact_dept: null,
    applicant_contact_phone: null,
    applicant_contact_email: null,
    product_url: null,
  }
}

// ---------------------------------------------------------------- 日付

function ymd(date: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** e-Gov の書き方 (西暦・半角・スラッシュ、例 2021/1/1)。読めなければ空 */
export function slashDate(date: string): string {
  const d = ymd(date)
  return d ? `${d[0]}/${d[1]}/${d[2]}` : ''
}

/** 国交省の様式の書き方 (令和 n 年 m 月 d 日)。読めなければ空欄のまま (令和　　年　　月　　日) */
export function reiwaDate(date: string): string {
  const d = ymd(date)
  if (!d || d[0] < 2019) return '令和　　年　　月　　日'
  return `令和${d[0] - 2018}年${d[1]}月${d[2]}日`
}

// ---------------------------------------------------------------- 機器の名称

/** #22 使用する機器の名称。自動点呼は認定番号も書く (参考様式の備考) */
export function deviceLabel(s: FilingSettings, kind: FilingKind): string {
  const name = s.device_name ?? ''
  if (kind === 'remote') return name
  const certs = [
    s.auto_cert_pre ? `業務前自動点呼機器 認定番号 ${s.auto_cert_pre}` : '',
    s.auto_cert_post ? `業務後自動点呼機器 認定番号 ${s.auto_cert_post}` : '',
  ].filter(Boolean)
  return certs.length ? `${name} (${certs.join('、')})` : name
}

// ---------------------------------------------------------------- e-Gov 参考様式 (xlsx)

/** 選択の欄の値 (様式の選択肢と同じ「番号 + 語」) */
function choice(n: number, label: string): string {
  return `${n}${label}`
}

/** 申請 n 件目 (0 始まり) の先頭の行。#17 = 22 行目から 7 行ずつ */
export function egovOfficeRow(i: number): number {
  return 22 + 7 * i
}

/**
 * e-Gov の参考様式 (シート「参考様式」の M 列「申請内容」) に書く値。キーはセル、値は書く文字。
 * 行は #番号で決まっている (#n は n + 5 行目)。チェック欄は □ を ☑ にした文。
 */
export function egovCells(s: FilingSettings, req: FilingRequest): Record<string, string> {
  const cells: Record<string, string> = {
    M8: slashDate(req.applyDate), // #3 申請日
    M10: s.business_number ?? '', // #5 事業者番号
    M11: s.trade_name ?? '', // #6 屋号等
    M15: choice(1, '実施'), // #10 届出・報告種別
    M17: s.business_type ? choice(s.business_type, BUSINESS_TYPES[s.business_type - 1]!) : '', // #12 事業種別
    M18: req.kind === 'remote' ? choice(4, '遠隔点呼') : choice(6, '自動点呼'), // #13 点呼の種別
    M19: slashDate(req.startDate), // #14 予定日
  }
  s.offices.slice(0, EGOV_OFFICE_SLOTS).forEach((o, i) => {
    const r = egovOfficeRow(i)
    cells[`M${r}`] = choice(o.role, OFFICE_ROLES[o.role - 1]!) // #17 実施・被実施の別
    cells[`M${r + 2}`] = o.name // #19 名称
    cells[`M${r + 3}`] = o.address ?? '' // #20 位置
    cells[`M${r + 5}`] = deviceLabel(s, req.kind) // #22 使用する機器の名称
  })
  if (req.kind === 'remote') {
    cells.M69 = choice(1, '点呼を行う運行管理者等が属する自社営業所') // #64
    cells.M70 = choice(1, '自社営業所又は自社営業所の車庫') // #65
  }
  return cells
}

/** チェック欄 (#67 添付・#69 宣誓 / #74 宣誓)。元の文の先頭の □ を ☑ にする */
export function egovChecks(kind: FilingKind): string[] {
  return kind === 'remote' ? ['M72', 'M74'] : ['M79']
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function colOf(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)![0]
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** 共有文字列 (sharedStrings.xml) の i 番目の文 */
function sharedStrings(xml: string): string[] {
  const out: string[] = []
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // ふりがな (<rPh>) は除く
    const body = si[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
    out.push([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''))
  }
  return out
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}

const CELL_RE = (ref: string) => new RegExp(`<c r="${ref}"(?:\\s[^>]*?)?(?:/>|>[\\s\\S]*?</c>)`)

/** セルの今の文 (共有文字列・inline のどちらも)。無ければ空 */
export function xlsxCellText(sheet: string, shared: string[], ref: string): string {
  const m = CELL_RE(ref).exec(sheet)
  if (!m) return ''
  const cell = m[0]
  const v = /<v>([\s\S]*?)<\/v>/.exec(cell)
  if (/\st="s"/.test(cell) && v) return unescapeXml(shared[Number(v[1])] ?? '')
  const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cell)
  return t ? unescapeXml(t[1]!) : v ? unescapeXml(v[1]!) : ''
}

/** シートの XML の 1 セルを inline の文にする (書式 `s` は残す)。行・セルが無ければ足す */
export function setXlsxCell(sheet: string, ref: string, text: string): string {
  const style = (cell: string) => /\ss="(\d+)"/.exec(cell)?.[1]
  const make = (s?: string) =>
    `<c r="${ref}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
  const found = CELL_RE(ref).exec(sheet)
  if (found) return sheet.replace(found[0], make(style(found[0])))
  const row = Number(/\d+$/.exec(ref)![0])
  const rowRe = new RegExp(`<row r="${row}"(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</row>)`)
  const rm = rowRe.exec(sheet)
  if (!rm) throw new Error(`様式の ${row} 行目が見つかりません`)
  const open = rm[0].replace(/\/>$/, '>').replace(/>[\s\S]*$/, '>')
  const cells = [...(rm[1] ?? '').matchAll(/<c r="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g)]
  const col = colOf(ref)
  const after = cells.find(c => colOf(c[1]!) > col)
  const inner = after
    ? (rm[1] ?? '').replace(after[0], make() + after[0])
    : (rm[1] ?? '') + make()
  return sheet.replace(rm[0], `${open}${inner}</row>`)
}

/** e-Gov の参考様式 (xlsx) に値を書く。シートは 1 枚目 */
export function fillEgovXlsx(file: Uint8Array, s: FilingSettings, req: FilingRequest): Uint8Array {
  const zip = unzipSync(file)
  const sheetPath = 'xl/worksheets/sheet1.xml'
  if (!zip[sheetPath]) throw new Error('参考様式のシートが見つかりません')
  let sheet = strFromU8(zip[sheetPath]!)
  const shared = zip['xl/sharedStrings.xml'] ? sharedStrings(strFromU8(zip['xl/sharedStrings.xml'])) : []
  // 位置の確かめ: #3 の行 (8 行目) の E 列が「申請日」で始まること
  if (!xlsxCellText(sheet, shared, 'E8').startsWith('申請日')) {
    throw new Error('参考様式の版が想定と違います (#3 申請日の位置が合いません)')
  }
  for (const [ref, text] of Object.entries(egovCells(s, req))) {
    if (text) sheet = setXlsxCell(sheet, ref, text)
  }
  for (const ref of egovChecks(req.kind)) {
    const now = xlsxCellText(sheet, shared, ref)
    sheet = setXlsxCell(sheet, ref, now.replace(/^□/, '☑'))
  }
  zip[sheetPath] = strToU8(sheet)
  // 値を書いたセルの式は無いが、Excel に開くときの再計算をさせる (calcChain は式のセルだけを持つので残す)
  return zipSync(zip, { level: 6 })
}

// ---------------------------------------------------------------- docx

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** 子孫の要素を localName で引く (接頭辞に頼らない。happy-dom は getElementsByTagNameNS で引けず、写した要素の接頭辞も落とす) */
function descendants(el: Element | Document, local: string): Element[] {
  return Array.from(el.getElementsByTagName('*')).filter(e => e.localName === local)
}

/** document.xml の本文を DOM で扱う小さな道具 */
export class DocxBody {
  readonly doc: Document
  readonly body: Element

  constructor(xml: string) {
    this.doc = new DOMParser().parseFromString(xml, 'application/xml')
    const body = descendants(this.doc, 'body')[0]
    if (!body) throw new Error('様式の本文が見つかりません')
    this.body = body
  }

  /** 本文の直下の i 番目の要素 (段落・表) */
  child(i: number): Element {
    const el = Array.from(this.body.children)[i]
    if (!el) throw new Error(`様式の本文に ${i} 番目の要素がありません`)
    return el
  }

  /** 本文の直下の表のうち n 番目 */
  table(n: number): Element {
    const t = Array.from(this.body.children).filter(e => e.localName === 'tbl')[n]
    if (!t) throw new Error(`様式に ${n + 1} 番目の表がありません`)
    return t
  }

  rows(tbl: Element): Element[] {
    return Array.from(tbl.children).filter(e => e.localName === 'tr')
  }

  /** 表の r 行 c 列の p 番目の段落 */
  cellPara(tbl: Element, r: number, c: number, p = 0): Element {
    const row = this.rows(tbl)[r]
    const cell = row && Array.from(row.children).filter(e => e.localName === 'tc')[c]
    const para = cell && Array.from(cell.children).filter(e => e.localName === 'p')[p]
    if (!para) throw new Error(`様式の表の ${r + 1} 行 ${c + 1} 列が見つかりません`)
    return para
  }

  static text(p: Element): string {
    return descendants(p, 't').map(t => t.textContent ?? '').join('')
  }

  /**
   * 段落の文を `f(今の文)` に置き換える。先頭の文の run に全部を書き、ほかの run の文は空にする
   * (先頭の run の書式を使う)。文の run が無ければ、段落の既定の書式で run を足す。
   * `expect` があれば、今の文がそれを含まないとき書かずに例外にする (様式の版のずれ)。
   */
  setText(p: Element, f: (now: string) => string, expect?: string): void {
    const now = DocxBody.text(p)
    if (expect !== undefined && !now.includes(expect)) {
      throw new Error(`様式の版が想定と違います (「${expect}」の位置が合いません)`)
    }
    const next = f(now)
    const ts = descendants(p, 't')
    let first = ts[0]
    if (!first) {
      const r = this.doc.createElementNS(W_NS, 'w:r')
      const pPr = descendants(p, 'pPr')[0]
      const rPr = pPr && descendants(pPr, 'rPr')[0]
      if (rPr) r.appendChild(rPr.cloneNode(true))
      first = this.doc.createElementNS(W_NS, 'w:t')
      r.appendChild(first)
      p.appendChild(r)
    }
    first.textContent = next
    first.setAttribute('xml:space', 'preserve')
    for (const t of ts.slice(1)) t.textContent = ''
  }

  xml(): string {
    return new XMLSerializer().serializeToString(this.doc)
  }
}

/** 「ラベル　　　」の段落を「ラベル　値」にする (ラベルより前の字下げは残す) */
function afterLabel(label: string, value: string | null): (now: string) => string {
  return (now) => {
    if (!value) return now
    const i = now.indexOf(label)
    return `${now.slice(0, i + label.length)}　${value}`
  }
}

/** 選ぶ語の前に ○ を付ける */
function circle(word: string): (now: string) => string {
  return now => now.replace(word, `○${word}`)
}

/** 別紙7 の営業所の欄の名称 (実施・被実施の別を書く) */
export function bessi7OfficeName(o: FilingOffice): string {
  const role = ['遠隔点呼実施営業所等', '被遠隔点呼実施営業所等', '遠隔点呼実施営業所等・被遠隔点呼実施営業所等'][o.role - 1]
  return role ? `${o.name}（${role}）` : o.name
}

/** 別紙7 の事業の種類の語 (#12 の番号 → 様式の語。旅客は別紙3) */
const BESSI7_TYPES: Record<number, string> = { 1: '一般貨物', 2: '特定貨物', 3: '貨物軽', 4: '特定第二種貨物利用運送' }

/** 国交省 別紙7 (遠隔点呼の実施に係る届出書・貨物)。位置は本文の要素の番号 */
export function fillBessi7(b: DocxBody, s: FilingSettings, req: FilingRequest): void {
  b.setText(b.child(3), () => reiwaDate(req.applyDate), '令和')
  b.setText(b.child(7), afterLabel('住所', s.operator_address), '住所')
  b.setText(b.child(8), afterLabel('氏名又は名称', s.operator_name), '氏名又は名称')
  b.setText(b.child(9), afterLabel('代表者氏名', s.operator_representative), '代表者氏名')
  b.setText(b.child(10), afterLabel('担当者氏名', s.operator_contact_name), '担当者氏名')
  b.setText(b.child(11), afterLabel('電話番号', s.operator_contact_phone), '電話番号')
  b.setText(b.child(12), afterLabel('ﾒｰﾙｱﾄﾞﾚｽ', s.operator_contact_email), 'ﾒｰﾙｱﾄﾞﾚｽ')
  const type = s.business_type ? BESSI7_TYPES[s.business_type] : undefined
  if (type) b.setText(b.child(19), circle(type), type)
  // 3. 営業所・車庫の名称等 (見出しの行の下に 2 行。足りなければ最後の行を写して足す)
  const tbl = b.table(0)
  b.setText(b.cellPara(tbl, 0, 0), now => now, '営業所・車庫の名称')
  const rows = b.rows(tbl)
  for (let i = rows.length - 1; i < s.offices.length; i++) {
    tbl.appendChild(rows[rows.length - 1]!.cloneNode(true))
  }
  s.offices.forEach((o, i) => {
    b.setText(b.cellPara(tbl, i + 1, 0), () => bessi7OfficeName(o))
    b.setText(b.cellPara(tbl, i + 1, 1), () => o.address ?? '')
    b.setText(b.cellPara(tbl, i + 1, 2), () => s.device_name ?? '')
  })
  if (req.startDate) b.setText(b.child(27), now => now.replace(/令和.*$/, reiwaDate(req.startDate)), '開始予定日')
  b.setText(b.child(30), now => now.replace('□', '☑'), '□')
}

/** 認定申請 様式1 (自動点呼機器認定申請書)。機器の種類は業務前・業務後の両方に ○ */
export function fillYoshiki1(b: DocxBody, s: FilingSettings, req: FilingRequest): void {
  b.setText(b.child(0), now => now.replace(/令和[\s　]*年[\s　]*月[\s　]*日/, reiwaDate(req.applyDate)), '令和')
  b.setText(b.child(4), afterLabel('住所', s.applicant_address), '住所')
  b.setText(b.child(5), afterLabel('氏名又は名称', s.applicant_name), '氏名又は名称')
  const who = b.table(0)
  b.setText(b.cellPara(who, 0, 1), now => (s.applicant_kana ? `（フリガナ）${s.applicant_kana}` : now), 'フリガナ')
  if (s.applicant_name) b.setText(b.cellPara(who, 1, 1), () => s.applicant_name!)
  if (s.applicant_address) {
    const a = s.applicant_address
    b.setText(b.cellPara(who, 2, 1), () => (a.startsWith('〒') ? a : `〒${a}`), '〒')
  }
  b.setText(b.cellPara(who, 3, 1), afterLabel('担当者名', s.applicant_contact_name), '担当者名')
  b.setText(b.cellPara(who, 4, 1), afterLabel('所属・役職', s.applicant_contact_dept), '所属・役職')
  b.setText(b.cellPara(who, 5, 1), afterLabel('電話番号', s.applicant_contact_phone), '電話番号')
  b.setText(b.cellPara(who, 6, 1), afterLabel('メールアドレス', s.applicant_contact_email), 'メールアドレス')
  const dev = b.table(1)
  b.setText(b.cellPara(dev, 0, 1), now => circle('業務後自動点呼機器')(circle('業務前自動点呼機器')(now)), '業務前自動点呼機器')
  b.setText(b.cellPara(dev, 1, 1), () => s.device_name ?? '')
  // 添付書類 1〜6 に ○ (7 その他は必要なときだけなので付けない)
  for (let i = 0; i < 6; i++) {
    b.setText(b.cellPara(dev, 2, 1, i), now => now.replace(/（[\s　]*）/, '（○）'), `${'１２３４５６'[i]}`)
  }
}

/** 認定申請 様式2 (自動点呼機器の概要)。被点呼対象者 ① 運転者のみ・被実施場所 ① 営業所又は車庫に限る */
export function fillYoshiki2(b: DocxBody, s: FilingSettings): void {
  const t = b.table(0)
  b.setText(b.cellPara(t, 0, 1), () => s.device_name ?? '')
  b.setText(b.cellPara(t, 1, 1), circle('①運転者のみ'), '①運転者のみ')
  b.setText(b.cellPara(t, 2, 1), circle('①営業所又は車庫に限る'), '①営業所又は車庫に限る')
  b.setText(b.cellPara(t, 3, 1), () => s.applicant_name ?? '')
  b.setText(b.cellPara(t, 4, 1), () => s.product_url ?? '')
}

/** docx の本文を書き換える */
export function fillDocx(file: Uint8Array, fill: (b: DocxBody) => void): Uint8Array {
  const zip = unzipSync(file)
  const path = 'word/document.xml'
  if (!zip[path]) throw new Error('様式の本文が見つかりません')
  const b = new DocxBody(strFromU8(zip[path]!))
  fill(b)
  zip[path] = strToU8(b.xml())
  return zipSync(zip, { level: 6 })
}

// ---------------------------------------------------------------- 様式の一覧と取得

export interface TenkoForm {
  /** tenko-forms の manifest の id */
  id: string
  label: string
  /** 対象の点呼の種別 (どちらでも使える様式は両方) */
  kinds: FilingKind[]
  ext: 'xlsx' | 'docx'
  fill: (file: Uint8Array, s: FilingSettings, req: FilingRequest) => Uint8Array
}

export const TENKO_FORMS: TenkoForm[] = [
  {
    id: 'egov-tenko-todokede-sankou',
    label: 'e-Gov 届出の参考様式 (xlsx)',
    kinds: ['remote', 'auto'],
    ext: 'xlsx',
    fill: fillEgovXlsx,
  },
  {
    id: 'remote-kamotsu-bessi7-jisshi',
    label: '別紙7 遠隔点呼の実施に係る届出書 (貨物)',
    kinds: ['remote'],
    ext: 'docx',
    fill: (f, s, r) => fillDocx(f, b => fillBessi7(b, s, r)),
  },
  {
    id: 'nintei-yoshiki1-shinsei',
    label: '認定申請 様式1 自動点呼機器認定申請書',
    kinds: ['auto'],
    ext: 'docx',
    fill: (f, s, r) => fillDocx(f, b => fillYoshiki1(b, s, r)),
  },
  {
    id: 'nintei-yoshiki2-gaiyo',
    label: '認定申請 様式2 自動点呼機器の概要',
    kinds: ['auto'],
    ext: 'docx',
    fill: (f, s) => fillDocx(f, b => fillYoshiki2(b, s)),
  },
]

/** manifest.json の `forms.<id>.latest` (最新版のパス) */
export async function latestFormPath(id: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`${TENKO_FORMS_RAW}manifest.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`様式の一覧を取得できませんでした (${res.status})`)
  const manifest = await res.json() as { forms?: Record<string, { latest?: string }> }
  const path = manifest.forms?.[id]?.latest
  if (!path) throw new Error(`様式 ${id} が一覧にありません`)
  return path
}

/** 最新版の様式を取り、値を書いた中身とファイル名を返す */
export async function buildFilledForm(
  form: TenkoForm,
  s: FilingSettings,
  req: FilingRequest,
  fetcher: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array, filename: string }> {
  const path = await latestFormPath(form.id, fetcher)
  const res = await fetcher(`${TENKO_FORMS_RAW}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`様式を取得できませんでした (${res.status})`)
  const bytes = form.fill(new Uint8Array(await res.arrayBuffer()), s, req)
  const version = /(\d{4}-\d{2}-\d{2})\.\w+$/.exec(path)?.[1] ?? 'latest'
  return { bytes, filename: `${form.id}_${req.kind}_${version}_記入済み.${form.ext}` }
}

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const

/** ブラウザに保存させる */
export function saveBytes(bytes: Uint8Array, filename: string, ext: keyof typeof MIME): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
