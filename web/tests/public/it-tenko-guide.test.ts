import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// IT点呼 の試験の手順書 (静的ファイル、Refs ippoan/alc-app#387)。
// public/ は認証なしで URL から直接読めるので、外部への参照が無いこと・原稿が欠けていないことを固定する
const html = readFileSync(resolve(__dirname, '../../public/it-tenko-guide.html'), 'utf8')

describe('public/it-tenko-guide.html', () => {
  it('外部への参照が無い (http:// も https:// も含まない)', () => {
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('検索に出さない (noindex)', () => {
    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('原稿が欠けていない (見出しと要の文言)', () => {
    for (const text of ['① 乗務員役', '② 運行管理者席', '未完了のまま終了', '通話なしで確定する', '対面で確認']) {
      expect(html).toContain(text)
    }
  })
})
