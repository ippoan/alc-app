import type { Ref, ComputedRef } from 'vue'

/**
 * インストールの単位。`index.vue` の RoleTab 5 つ (運行者 / 運行管理者 / システム管理者 /
 * 汎用管理 / IT点呼) に、運行者タブの中の血圧測定タブ (`?tab=bp`) を別アプリとして
 * 切り出した `'bp'` を足したもの (Refs ippoan/alc-app-s3#135)。`?role=` に書けるのは
 * RoleTab の 5 つだけで、`'bp'` は `?tab=` から決まる。
 */
export type ManifestRole = 'driver' | 'manager' | 'admin' | 'general' | 'it_tenko' | 'bp'

/** `?role=` として受け付ける値 (= index.vue の RoleTab) */
const ROLES: ManifestRole[] = ['driver', 'manager', 'admin', 'general', 'it_tenko']

/** 血圧測定タブの `?tab=` (index.vue の DriverSubTab と同じ値) */
export const BP_TAB = 'bp'

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

/**
 * 血圧測定端末用 (Refs ippoan/alc-app-s3#135)。測る場所と点呼する場所を分けたいので、
 * 血圧だけを測る端末を別アイコンでインストールできるようにする。
 * `start_url` が `?tab=bp` なので、起動すると血圧測定タブが開く。
 */
export const BP_MANIFEST: RoleManifest = {
  href: '/manifest-bp.webmanifest',
  themeColor: '#0f766e',
}

/**
 * 運行管理者側の IT点呼 の受け画面用 (Refs ippoan/alc-app#387)。役割タブ「IT点呼」
 * (`?role=it_tenko`) を別アイコンでインストールできるようにする。
 *
 * **manifest は URL の `?role=` だけで決まる** (SSR の HTML に出すため、端末の開発用の印は
 * 見られない)。印の無い端末が `?role=it_tenko` を直接開くと、画面は運行者に倒れるが
 * (`index.vue`)、`<link rel="manifest">` はこれが出る。
 */
export const IT_TENKO_MANIFEST: RoleManifest = {
  href: '/manifest-it-tenko.webmanifest',
  themeColor: '#6d28d9',
}

/** 運行者以外の manifest。ここに無いロールは運行者と同じ扱い (別アプリにしない) */
const MANIFEST_BY_ROLE: Partial<Record<ManifestRole, RoleManifest>> = {
  manager: MANAGER_MANIFEST,
  it_tenko: IT_TENKO_MANIFEST,
  bp: BP_MANIFEST,
}

/** vue-router は同名クエリが複数あると配列で返すので先頭だけ見る (index.vue の queryTab と同じ) */
function first(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s : undefined
}

/**
 * URL クエリからインストールの単位を決める。`index.vue` の activeRole の初期値と同じ規則:
 * 着信通知からの直行 (`?mode=incoming_call`) は運行管理者、それ以外は `?role=`、
 * 未知の値と無指定は運行者。
 *
 * ただし運行者のうち血圧測定タブ (`?tab=bp`) だけは別アプリ (`'bp'`) として扱う —
 * 血圧しか測らない端末を別アイコンで入れるため。`?tab=` は運行者のときしか
 * サブタブの意味を持たないので (index.vue の onAdminTabChange 参照)、
 * 運行管理者・システム管理者・IT点呼 の `?tab=bp` は素通しする。
 */
export function manifestRoleFromQuery(query: Record<string, unknown>): ManifestRole {
  if (first(query.mode) === 'incoming_call') return 'manager'
  const role = first(query.role) as ManifestRole | undefined
  const resolved = role && ROLES.includes(role) ? role : 'driver'
  if (resolved === 'driver' && first(query.tab) === BP_TAB) return 'bp'
  return resolved
}

/**
 * 運行者・運行管理者・血圧測定端末・IT点呼 を別々の PWA としてインストールできるように、
 * manifest を出し分ける (Refs #179, ippoan/alc-app-s3#135, ippoan/alc-app#387)。実体は
 * `web/public/manifest-{driver,manager,bp,it-tenko}.webmanifest`。
 *
 * 呼び出すのは `app.vue` 1 か所だけ — トップ画面 (`index.vue`) から呼ぶと、
 * 認証の初期化が終わるまで `app.vue` がスピナーだけを描くぶん SSR の HTML に
 * `<link rel="manifest">` が出ず、Chrome が初回ロード時点で manifest を読めない。
 */
export function useRoleManifest(role: Ref<ManifestRole> | ComputedRef<ManifestRole>) {
  const manifest = computed(() => MANIFEST_BY_ROLE[role.value] ?? DRIVER_MANIFEST)
  const manifestHref = computed(() => manifest.value.href)
  const themeColor = computed(() => manifest.value.themeColor)
  return { manifest, manifestHref, themeColor }
}
