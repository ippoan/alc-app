import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DRIVER_MANIFEST, MANAGER_MANIFEST, BP_MANIFEST, IT_TENKO_MANIFEST } from '~/composables/useRoleManifest'

const publicDir = resolve(import.meta.dirname!, '../../public')

function readManifest(file: string) {
  return JSON.parse(readFileSync(resolve(publicDir, file), 'utf-8'))
}

const driver = readManifest('manifest-driver.webmanifest')
const manager = readManifest('manifest-manager.webmanifest')
// 血圧だけを測る端末を別アイコンで入れるための 3 本目 (Refs ippoan/alc-app-s3#135)
const bp = readManifest('manifest-bp.webmanifest')
// 運行管理者側の IT点呼 の受け画面を別アイコンで入れるための 4 本目 (Refs ippoan/alc-app#387)
const itTenko = readManifest('manifest-it-tenko.webmanifest')

describe('public/manifest-*.webmanifest', () => {
  it.each([
    ['driver', driver],
    ['manager', manager],
    ['bp', bp],
    ['it-tenko', itTenko],
  ])('%s は Chrome のインストール要件のキーを持つ', (_name, m) => {
    for (const key of ['id', 'start_url', 'name', 'short_name', 'icons', 'display', 'scope']) {
      expect(m[key], key).toBeTruthy()
    }
    expect(m.display).toBe('standalone')
    expect(m.scope).toBe('/')
    expect(m.background_color).toBe('#ffffff')
    expect(m.lang).toBe('ja')
    expect(Array.isArray(m.icons)).toBe(true)
    expect(m.icons.length).toBeGreaterThan(0)
    for (const icon of m.icons) {
      expect(icon.src.startsWith('/')).toBe(true)
      expect(icon.sizes).toBeTruthy()
      expect(icon.type).toBeTruthy()
    }
  })

  it('id と start_url が互いに違う (同じだと Chrome が「インストール済み」と扱う)', () => {
    const ids = [driver.id, manager.id, bp.id, itTenko.id]
    const startUrls = [driver.start_url, manager.start_url, bp.start_url, itTenko.start_url]
    const names = [driver.name, manager.name, bp.name, itTenko.name]
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(startUrls).size).toBe(startUrls.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it('start_url にロールが入っていて、インストール後の起動でロールが決まる', () => {
    expect(driver.id).toBe('/?role=driver')
    expect(driver.start_url).toBe('/?role=driver')
    expect(manager.id).toBe('/?role=manager')
    expect(manager.start_url).toBe('/?role=manager')
    // 血圧端末は運行者ロールの血圧測定タブ (`?tab=bp`) を直接開く。`station=bp` は
    // 「測定台として起動したか」の印 — `?tab=bp` だけだと通常端末が血圧測定タブを
    // 選んでリロードしたときにも同じ形になり誤爆する (Refs ippoan/alc-app#353、裏取りで発覚)
    expect(bp.id).toBe('/?role=driver&tab=bp&station=bp')
    expect(bp.start_url).toBe('/?role=driver&tab=bp&station=bp')
    // IT点呼 は役割タブ (`?role=it_tenko`) を直接開く
    expect(itTenko.id).toBe('/?role=it_tenko')
    expect(itTenko.start_url).toBe('/?role=it_tenko')
    expect(itTenko.name).toBe('IT点呼')
    expect(itTenko.short_name).toBe('IT点呼')
  })

  it('start_url は相対パス (public repo に実ホスト名を書かない)', () => {
    for (const m of [driver, manager, bp, itTenko]) {
      expect(m.start_url.startsWith('/')).toBe(true)
      expect(m.id.startsWith('/')).toBe(true)
    }
  })

  it('launch_handler focus-existing — OS からの起動は既存ウィンドウにフォーカスし 2 つ目を開かない (Refs #204)', () => {
    for (const m of [driver, manager, bp, itTenko]) {
      expect(m.launch_handler).toEqual({ client_mode: 'focus-existing' })
    }
  })

  it('theme_color が useRoleManifest の定数と一致する', () => {
    expect(driver.theme_color).toBe(DRIVER_MANIFEST.themeColor)
    expect(manager.theme_color).toBe(MANAGER_MANIFEST.themeColor)
    expect(bp.theme_color).toBe(BP_MANIFEST.themeColor)
    expect(itTenko.theme_color).toBe(IT_TENKO_MANIFEST.themeColor)
  })

  it('theme_color は 4 つとも別 (タスクバーとタイトルバーで見分ける)', () => {
    const colors = [driver, manager, bp, itTenko].map(m => m.theme_color)
    expect(new Set(colors).size).toBe(colors.length)
  })

  // 役割ごとの PWA (運行者以外) のアイコン。共通の PNG を候補に並べると Chrome が寸法の合う
  // そちらを選び、役割の絵にならない (Refs ippoan/alc-app#387)
  const roleIcons = [
    ['運行管理者', manager, 'manager', MANAGER_MANIFEST.themeColor],
    ['血圧端末', bp, 'bp', BP_MANIFEST.themeColor],
    ['IT点呼', itTenko, 'it-tenko', IT_TENKO_MANIFEST.themeColor],
  ] as const
  const sharedPngs = ['icon-192.png', 'icon-512.png'].map(f => readFileSync(resolve(publicDir, f)))

  it.each(roleIcons)('%s のアイコンは役割の PNG 2 枚 + SVG だけで、共通の PNG を持たない', (_name, m, slug, themeColor) => {
    // (a) 並びの固定。共通の `/icon-192.png`・`/icon-512.png` が在るとここで落ちる
    expect(m.icons).toEqual([
      { src: `/icon-${slug}-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `/icon-${slug}-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `/icon-${slug}.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ])

    // (b) PNG の実体: 署名と IHDR の幅・高さ (16〜23 バイト目、big-endian)
    const pngs = [192, 512].map((size) => {
      const png = readFileSync(resolve(publicDir, `icon-${slug}-${size}.png`))
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
      return png
    })

    // (c) SVG は残す
    const svg = readFileSync(resolve(publicDir, `icon-${slug}.svg`), 'utf-8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 512 512"')
    expect(svg).toContain(themeColor)
    // フォントに依存すると環境によっては白紙になるので図形だけで描く
    expect(svg).not.toContain('<text')
    // 外部の画像・フォントを参照しない (SVG 単体で完結。xmlns の宣言だけは URL の形)
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|href=/)

    // (d) ほかの役割とも共通の PNG とも絵が違う (バイト比較)
    for (const [, , other] of roleIcons.filter(r => r[2] !== slug)) {
      expect(svg).not.toBe(readFileSync(resolve(publicDir, `icon-${other}.svg`), 'utf-8'))
      for (const [i, size] of [192, 512].entries()) {
        expect(pngs[i]!.equals(readFileSync(resolve(publicDir, `icon-${other}-${size}.png`)))).toBe(false)
      }
    }
    for (const png of pngs) {
      for (const shared of sharedPngs) expect(png.equals(shared)).toBe(false)
    }
  })

  it('運行者は共通の PNG 2 枚を持つ (回帰)', () => {
    expect(driver.icons.map((i: { src: string }) => i.src)).toEqual(['/icon-192.png', '/icon-512.png'])
  })

  it('manifest の href は useRoleManifest が指すファイル名と一致する', () => {
    expect(DRIVER_MANIFEST.href).toBe('/manifest-driver.webmanifest')
    expect(MANAGER_MANIFEST.href).toBe('/manifest-manager.webmanifest')
    expect(BP_MANIFEST.href).toBe('/manifest-bp.webmanifest')
    expect(() => readManifest(DRIVER_MANIFEST.href.slice(1))).not.toThrow()
    expect(() => readManifest(MANAGER_MANIFEST.href.slice(1))).not.toThrow()
    expect(() => readManifest(BP_MANIFEST.href.slice(1))).not.toThrow()
    expect(IT_TENKO_MANIFEST.href).toBe('/manifest-it-tenko.webmanifest')
    expect(() => readManifest(IT_TENKO_MANIFEST.href.slice(1))).not.toThrow()
  })
})
