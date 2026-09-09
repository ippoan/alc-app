import type { Ref, ComputedRef } from 'vue'

/** トップ画面のロールタブ (`?role=`)。`index.vue` の RoleTab と同じ集合 */
export type ManifestRole = 'driver' | 'manager' | 'admin' | 'general'

const ROLES: ManifestRole[] = ['driver', 'manager', 'admin', 'general']

/** `<link rel="manifest">` と `<meta name="theme-color">` の組 */
export interface RoleManifest {
  href: string
  themeColor: string
}

/**
 * 運行者 (点呼キオスク) 用。`admin` / `general` もこちらを使う — 別アプリにはしない。
 */
export const DRIVER_MANIFEST: RoleManifest = {
  href: '/manifest-driver.webmanifest',
  themeColor: '#1e40af',
}

/** 運行管理者用。`id` / `start_url` が違うので Chrome は別アプリとして扱う */
export const MANAGER_MANIFEST: RoleManifest = {
  href: '/manifest-manager.webmanifest',
  themeColor: '#b45309',
}

/** vue-router は同名クエリが複数あると配列で返すので先頭だけ見る (index.vue の queryTab と同じ) */
function first(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s : undefined
}

/**
 * URL クエリからロールを決める。`index.vue` の activeRole の初期値と同じ規則:
 * 着信通知からの直行 (`?mode=incoming_call`) は運行管理者、それ以外は `?role=`、
 * 未知の値と無指定は運行者。
 */
export function manifestRoleFromQuery(query: Record<string, unknown>): ManifestRole {
  if (first(query.mode) === 'incoming_call') return 'manager'
  const role = first(query.role) as ManifestRole | undefined
  return role && ROLES.includes(role) ? role : 'driver'
}

/**
 * 運行者と運行管理者を別々の PWA としてインストールできるように、manifest を出し分ける
 * (Refs #179)。実体は `web/public/manifest-{driver,manager}.webmanifest`。
 *
 * 呼び出すのは `app.vue` 1 か所だけ — トップ画面 (`index.vue`) から呼ぶと、
 * 認証の初期化が終わるまで `app.vue` がスピナーだけを描くぶん SSR の HTML に
 * `<link rel="manifest">` が出ず、Chrome が初回ロード時点で manifest を読めない。
 */
export function useRoleManifest(role: Ref<ManifestRole> | ComputedRef<ManifestRole>) {
  const manifest = computed(() => (role.value === 'manager' ? MANAGER_MANIFEST : DRIVER_MANIFEST))
  const manifestHref = computed(() => manifest.value.href)
  const themeColor = computed(() => manifest.value.themeColor)
  return { manifest, manifestHref, themeColor }
}
