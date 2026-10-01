import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { withSetup } from '../helpers/with-setup'
import {
  useRoleManifest,
  manifestRoleFromQuery,
  DRIVER_MANIFEST,
  MANAGER_MANIFEST,
  BP_MANIFEST,
  IT_TENKO_MANIFEST,
  type ManifestRole,
} from '~/composables/useRoleManifest'

describe('useRoleManifest', () => {
  it('manager は運行管理者の manifest と amber の theme-color', () => {
    const role = ref<ManifestRole>('manager')
    const [result, app] = withSetup(() => useRoleManifest(role))
    expect(result.manifestHref.value).toBe('/manifest-manager.webmanifest')
    expect(result.themeColor.value).toBe('#b45309')
    expect(result.manifest.value).toEqual(MANAGER_MANIFEST)
    app.unmount()
  })

  it.each<ManifestRole>(['driver', 'admin', 'general'])(
    '%s は運行者の manifest (別アプリにしない)',
    (r) => {
      const role = ref<ManifestRole>(r)
      const [result, app] = withSetup(() => useRoleManifest(role))
      expect(result.manifestHref.value).toBe('/manifest-driver.webmanifest')
      expect(result.themeColor.value).toBe('#1e40af')
      expect(result.manifest.value).toEqual(DRIVER_MANIFEST)
      app.unmount()
    },
  )

  it('bp は血圧端末の manifest と teal の theme-color (別アプリとしてインストールさせる)', () => {
    const role = ref<ManifestRole>('bp')
    const [result, app] = withSetup(() => useRoleManifest(role))
    expect(result.manifestHref.value).toBe('/manifest-bp.webmanifest')
    expect(result.themeColor.value).toBe('#0f766e')
    expect(result.manifest.value).toEqual(BP_MANIFEST)
    app.unmount()
  })

  it('it_tenko は IT点呼 の manifest と violet の theme-color (別アプリとしてインストールさせる。Refs ippoan/alc-app#387)', () => {
    const role = ref<ManifestRole>('it_tenko')
    const [result, app] = withSetup(() => useRoleManifest(role))
    expect(result.manifestHref.value).toBe('/manifest-it-tenko.webmanifest')
    expect(result.themeColor.value).toBe('#6d28d9')
    expect(result.manifest.value).toEqual(IT_TENKO_MANIFEST)
    app.unmount()
  })

  it('ロールタブの切替に追従する', () => {
    const role = ref<ManifestRole>('driver')
    const [result, app] = withSetup(() => useRoleManifest(role))
    expect(result.manifestHref.value).toBe('/manifest-driver.webmanifest')

    role.value = 'manager'
    expect(result.manifestHref.value).toBe('/manifest-manager.webmanifest')
    expect(result.themeColor.value).toBe('#b45309')

    role.value = 'bp'
    expect(result.manifestHref.value).toBe('/manifest-bp.webmanifest')
    expect(result.themeColor.value).toBe('#0f766e')

    role.value = 'it_tenko'
    expect(result.manifestHref.value).toBe('/manifest-it-tenko.webmanifest')
    expect(result.themeColor.value).toBe('#6d28d9')

    role.value = 'general'
    expect(result.manifestHref.value).toBe('/manifest-driver.webmanifest')
    app.unmount()
  })

  it('4 つの manifest は href も theme-color も別 (同じだと Chrome が区別できない)', () => {
    const all = [DRIVER_MANIFEST, MANAGER_MANIFEST, BP_MANIFEST, IT_TENKO_MANIFEST]
    const hrefs = all.map(m => m.href)
    const colors = all.map(m => m.themeColor)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(new Set(colors).size).toBe(colors.length)
  })
})

describe('manifestRoleFromQuery', () => {
  it.each<[string, Record<string, unknown>, ManifestRole]>([
    ['?role=driver', { role: 'driver' }, 'driver'],
    ['?role=manager', { role: 'manager' }, 'manager'],
    ['?role=admin', { role: 'admin' }, 'admin'],
    ['?role=general', { role: 'general' }, 'general'],
    ['クエリなし', {}, 'driver'],
    ['未知のロール', { role: 'nope' }, 'driver'],
    // 運行管理者側の IT点呼 の役割タブ (Refs ippoan/alc-app#387)。別の PWA として入れられる
    ['?role=it_tenko', { role: 'it_tenko' }, 'it_tenko'],
    ['IT点呼 の ?tab=bp は素通し', { role: 'it_tenko', tab: 'bp' }, 'it_tenko'],
    ['着信通知は ?role=it_tenko より優先', { mode: 'incoming_call', role: 'it_tenko' }, 'manager'],
    ['role が空', { role: '' }, 'driver'],
    ['role が null (?role)', { role: null }, 'driver'],
    ['着信通知からの直行', { mode: 'incoming_call' }, 'manager'],
    ['着信通知は role より優先', { mode: 'incoming_call', role: 'driver' }, 'manager'],
    ['mode が別の値', { mode: 'other', role: 'manager' }, 'manager'],
    ['同名クエリが複数 (配列)', { role: ['manager', 'driver'] }, 'manager'],
    ['mode が配列', { mode: ['incoming_call'] }, 'manager'],
    // 血圧測定タブ (`?tab=bp`) は運行者の中の別アプリ (Refs ippoan/alc-app-s3#135)
    ['?role=driver&tab=bp', { role: 'driver', tab: 'bp' }, 'bp'],
    ['role 無しの ?tab=bp', { tab: 'bp' }, 'bp'],
    ['tab が配列', { tab: ['bp', 'tenko'] }, 'bp'],
    ['運行者の別のタブ', { role: 'driver', tab: 'tenko' }, 'driver'],
    ['tab が null', { role: 'driver', tab: null }, 'driver'],
    // `?tab=` は運行者のときしかサブタブの意味を持たない (index.vue の onAdminTabChange)
    ['管理者の ?tab=bp は素通し', { role: 'admin', tab: 'bp' }, 'admin'],
    ['着信通知は ?tab=bp より優先', { mode: 'incoming_call', tab: 'bp' }, 'manager'],
  ])('%s → %s', (_label, query, expected) => {
    expect(manifestRoleFromQuery(query)).toBe(expected)
  })
})
