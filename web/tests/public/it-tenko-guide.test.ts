import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// IT点呼 の手順書 (静的ファイル、Refs ippoan/alc-app#387)。点呼をする人の操作だけを書く。
// public/ は認証なしで URL から直接読めるので、外部への参照が無いこと・原稿が欠けていないことを固定する
const html = readFileSync(resolve(import.meta.dirname!, '../../public/it-tenko-guide.html'), 'utf8')

describe('public/it-tenko-guide.html', () => {
  it('外部への参照が無い (http:// も https:// も含まない)', () => {
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('検索に出さない (noindex)', () => {
    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('原稿が欠けていない (見出しと要の文言)', () => {
    for (const text of [
      '<title>IT点呼 の手順</title>',
      'IT点呼 の手順<br>① 乗務員 (点呼を受ける側)',
      'IT点呼 の手順<br>② 運行管理者席 (点呼をする側)',
      // ① 画面の文言 (NormalMeasurement.vue) と一字一句合わせる
      '運転免許証',
      '保存の方法を選んでください',
      'IT点呼 (運行管理者と通話)',
      '30 秒押さないと、通常点呼として保存されます',
      'IT点呼 — 運行管理者の判定を待っています',
      '未完了のまま終了',
      // ② 画面の文言 (TenkoItAdminView.vue / TenkoManagerJudgmentPanel.vue)
      '警告デバイス (卓上の機器)',
      'この席の運行管理者を登録してください (社員番号)',
      '>登録<',
      '>変更<',
      '>通話する<',
      '警告デバイス本体のボタンでも応答できます',
      '社員証か運転免許証を警告デバイスにタッチしても登録できます。',
      '運行管理者の判定',
      'IT点呼 (通話で確認)',
      'NG として記録する',
      '未完了の IT点呼',
      '通話なしで確定する',
      '対面で確認',
    ]) {
      expect(html).toContain(text)
    }
  })

  // 利用者が読む文に、作る側の事情の語を書かない
  it.each(['試験', '開発', '本番'])('「%s」の語が 1 つも無い', (word) => {
    expect(html).not.toContain(word)
  })

  it('連絡・記入を求める文、実施記録の欄・チェック欄が無い', () => {
    for (const text of ['連絡してください', '記録に書いてください', '切り替えた', '実施日', '□', '<table']) {
      expect(html).not.toContain(text)
    }
  })

  // 乗務員には通常点呼の中で選ぶ経路だけを案内する (運行者のメニューの「IT点呼」は書かない)
  it('運行者のメニューの経路を書かない', () => {
    expect(html).not.toContain('メニュー')
    expect(html).not.toContain('三本線')
  })

  // 運行管理者側の IT点呼 は、画面最上段の役割のタブに在る (運行管理者の画面の中のタブではない)
  it('IT点呼 のタブの場所は、最上段の役割のタブとして案内する', () => {
    expect(html).toContain('画面のいちばん上の役割のタブ')
    expect(html).toContain('運行管理者の画面に入らなくても開けます')
    expect(html).not.toContain('「遠隔点呼」の右')
  })
})
