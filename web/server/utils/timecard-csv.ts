/**
 * 打刻の CSV の「デバイス」列を、端末の名前に替える純粋ロジック (Refs ippoan/alc-cam#2)。
 * backend (rust-alc-api `export_csv`) の CSV は鍵のラベルを持たないので、名前は alc-app の route が引いて差し込む。
 *
 * 他の列・列の位置・BOM・改行・引用符の付け方は一切変えない: 行と欄を**生の文字列のまま**切り出し、
 * デバイス列の欄だけを引用符を外して → 名前に替えて → 必要なら引用符を付け直す。
 */

/** backend の CSV のヘッダーでデバイス列を指す名前 (`alc-misc/src/timecard.rs` の `export_csv`) */
export const DEVICE_COLUMN_HEADER = 'デバイス'

const BOM = '﻿'

interface RawRecord {
  fields: string[]
  /** 行末 (`\n` / `\r\n`。最終行に改行が無ければ空) */
  eol: string
}

/** CSV を行と欄に切る (欄は引用符付きのまま)。引用符の中の `,` と改行は区切りにしない */
function splitRaw(text: string): RawRecord[] {
  const records: RawRecord[] = []
  let fields: string[] = []
  let start = 0
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      quoted = !quoted
    }
    else if (!quoted && ch === ',') {
      fields.push(text.slice(start, i))
      start = i + 1
    }
    else if (!quoted && (ch === '\n' || (ch === '\r' && text[i + 1] === '\n'))) {
      const eol = ch === '\n' ? '\n' : '\r\n'
      fields.push(text.slice(start, i))
      records.push({ fields, eol })
      fields = []
      i += eol.length - 1
      start = i + 1
    }
  }
  // 最終行に改行が無いとき。末尾が `,` で終わる (最後の欄が空の) 行も、空の欄を足して残す
  if (fields.length > 0 || start < text.length) {
    fields.push(text.slice(start))
    records.push({ fields, eol: '' })
  }
  return records
}

function unquote(raw: string): string {
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw
}

function quoteIfNeeded(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * CSV の「デバイス」列の値を `rename` で替えた CSV を返す。空の欄は替えない (端末の記録が無い打刻)。
 * ヘッダーにデバイス列が無ければ (backend の形が変わった) 何も替えずそのまま返す。
 */
export function renameDeviceColumn(csv: string, rename: (deviceId: string) => string): string {
  const bom = csv.startsWith(BOM) ? BOM : ''
  const records = splitRaw(csv.slice(bom.length))
  const col = records[0]?.fields.map(unquote).indexOf(DEVICE_COLUMN_HEADER) ?? -1
  if (col < 0) return csv
  for (const r of records.slice(1)) {
    const raw = r.fields[col]
    if (raw === undefined) continue
    const id = unquote(raw)
    if (id !== '') r.fields[col] = quoteIfNeeded(rename(id))
  }
  return bom + records.map(r => r.fields.join(',') + r.eol).join('')
}
