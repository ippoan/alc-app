import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { withSetup } from '../helpers/with-setup'
import {
  useRoleManifest,
  manifestRoleFromQuery,
  DRIVER_MANIFEST,
  MANAGER_MANIFEST,
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

  it('ロールタブの切替に追従する', () => {
    const role = ref<ManifestRole>('driver')
    const [result, app] = withSetup(() => useRoleManifest(role))
    expect(result.manifestHref.value).toBe('/manifest-driver.webmanifest')

    role.value = 'manager'
    expect(result.manifestHref.value).toBe('/manifest-manager.webmanifest')
    expect(result.themeColor.value).toBe('#b45309')

    role.value = 'general'
    expect(result.manifestHref.value).toBe('/manifest-driver.webmanifest')
    app.unmount()
  })

  it('2 つの manifest は href も theme-color も別 (同じだと Chrome が区別できない)', () => {
    expect(DRIVER_MANIFEST.href).not.toBe(MANAGER_MANIFEST.href)
    expect(DRIVER_MANIFEST.themeColor).not.toBe(MANAGER_MANIFEST.themeColor)
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
    ['role が空', { role: '' }, 'driver'],
    ['role が null (?role)', { role: null }, 'driver'],
    ['着信通知からの直行', { mode: 'incoming_call' }, 'manager'],
    ['着信通知は role より優先', { mode: 'incoming_call', role: 'driver' }, 'manager'],
    ['mode が別の値', { mode: 'other', role: 'manager' }, 'manager'],
    ['同名クエリが複数 (配列)', { role: ['manager', 'driver'] }, 'manager'],
    ['mode が配列', { mode: ['incoming_call'] }, 'manager'],
  ])('%s → %s', (_label, query, expected) => {
    expect(manifestRoleFromQuery(query)).toBe(expected)
  })
})
