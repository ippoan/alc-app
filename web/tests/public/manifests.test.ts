import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DRIVER_MANIFEST, MANAGER_MANIFEST } from '~/composables/useRoleManifest'

const publicDir = resolve(import.meta.dirname!, '../../public')

function readManifest(file: string) {
  return JSON.parse(readFileSync(resolve(publicDir, file), 'utf-8'))
}

const driver = readManifest('manifest-driver.webmanifest')
const manager = readManifest('manifest-manager.webmanifest')

describe('public/manifest-*.webmanifest', () => {
  it.each([
    ['driver', driver],
    ['manager', manager],
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
    expect(driver.id).not.toBe(manager.id)
    expect(driver.start_url).not.toBe(manager.start_url)
    expect(driver.name).not.toBe(manager.name)
  })

  it('start_url にロールが入っていて、インストール後の起動でロールが決まる', () => {
    expect(driver.id).toBe('/?role=driver')
    expect(driver.start_url).toBe('/?role=driver')
    expect(manager.id).toBe('/?role=manager')
    expect(manager.start_url).toBe('/?role=manager')
  })

  it('start_url は相対パス (public repo に実ホスト名を書かない)', () => {
    for (const m of [driver, manager]) {
      expect(m.start_url.startsWith('/')).toBe(true)
      expect(m.id.startsWith('/')).toBe(true)
    }
  })

  it('launch_handler focus-existing — OS からの起動は既存ウィンドウにフォーカスし 2 つ目を開かない (Refs #204)', () => {
    for (const m of [driver, manager]) {
      expect(m.launch_handler).toEqual({ client_mode: 'focus-existing' })
    }
  })

  it('theme_color が useRoleManifest の定数と一致する', () => {
    expect(driver.theme_color).toBe(DRIVER_MANIFEST.themeColor)
    expect(manager.theme_color).toBe(MANAGER_MANIFEST.themeColor)
  })

  it('運行管理者は色違いの専用アイコンを先頭に持つ (タスクバーで区別する)', () => {
    expect(manager.icons[0].src).toBe('/icon-manager.svg')
    expect(manager.icons[0].type).toBe('image/svg+xml')
    expect(manager.icons[0].sizes).toBe('any')
    expect(manager.icons[0].purpose).toBe('any maskable')
    // 既存 PNG も fallback として並べる
    expect(manager.icons.map((i: { src: string }) => i.src)).toContain('/icon-512.png')

    const svg = readFileSync(resolve(publicDir, 'icon-manager.svg'), 'utf-8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 512 512"')
    expect(svg).toContain(MANAGER_MANIFEST.themeColor)
    // フォントに依存すると環境によっては白紙になるので図形だけで描く
    expect(svg).not.toContain('<text')
  })

  it('manifest の href は useRoleManifest が指すファイル名と一致する', () => {
    expect(DRIVER_MANIFEST.href).toBe('/manifest-driver.webmanifest')
    expect(MANAGER_MANIFEST.href).toBe('/manifest-manager.webmanifest')
    expect(() => readManifest(DRIVER_MANIFEST.href.slice(1))).not.toThrow()
    expect(() => readManifest(MANAGER_MANIFEST.href.slice(1))).not.toThrow()
  })
})
