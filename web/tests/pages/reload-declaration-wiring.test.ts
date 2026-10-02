import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

// 新版への載せ替え (待機中の自動リロード) の**申告漏れを見つける配線テスト** (Refs ippoan/alc-app#387)。
//
// 待機中の画面は「いまリロードして失うものが無い」と申告しない限り、古い版を永久に掴み続ける
// (`utils/app-update-gate.ts` は fail-closed)。この型の漏れは #338 → #341 → #345 → #387 と
// 4 回起きた — 画面を足した人が申告の口 (`useKioskScreen`) を知らないと、黙って対象外になる。
//
// そこで、トップ画面 (`pages/index.vue`) と運行管理者のダッシュボード (`ManagerDashboard.vue`) が
// 載せる画面の一覧を**ソースから取り出し**、下の表と突き合わせる。
// **画面・タブを足したら、この表に 1 行足す** — 待機中に更新してよい画面なら申告を足して
// `declares` を書き、入力・設定の途中を失う画面なら `null` と理由を書く。

const APP = resolve(import.meta.dirname!, '../../app')
const read = (path: string) => readFileSync(resolve(APP, path), 'utf-8')

/** 申告の種類。`track` = キオスクの現在地 / `safe` = 「いま失うものが無い」/ null = 意図して申告しない */
type Declares = 'track' | 'safe' | null

interface Row {
  /** その役割・タブで載る component (ソースに出る順) */
  components: string[]
  declares: Declares
  /** 申告する component (`declares` が null でないとき。`components` のどれか) */
  by?: string
  /** 申告しない理由 (`declares` が null のとき。リロードで失うもの) */
  reason?: string
}

/** 運行者のサブタブ (`pages/index.vue` の `DriverSubTab`) */
const DRIVER_TABS: Record<string, Row> = {
  normal: { components: ['NormalMeasurement'], declares: 'safe', by: 'NormalMeasurement' },
  it: { components: ['NormalMeasurement'], declares: 'safe', by: 'NormalMeasurement' },
  tenko: { components: ['TenkoKiosk'], declares: 'track', by: 'TenkoKiosk' },
  remote: { components: ['TenkoKiosk'], declares: 'track', by: 'TenkoKiosk' },
  demo: { components: ['TenkoKiosk'], declares: 'track', by: 'TenkoKiosk' },
  remote_demo: { components: ['TenkoKiosk'], declares: 'track', by: 'TenkoKiosk' },
  bp: { components: ['BloodPressureMeasurement'], declares: 'safe', by: 'BloodPressureMeasurement' },
  device: { components: ['DeviceSettings'], declares: null, reason: '設定' },
  dev_records: { components: ['DevDeviceRecords'], declares: null, reason: '閲覧' },
}

/** 運行者以外の役割 (`pages/index.vue` の `RoleTab`)。運行管理者はタブごと (下の表) */
const ROLES: Record<string, Row | 'driver-tabs' | 'manager-tabs'> = {
  driver: 'driver-tabs',
  manager: 'manager-tabs',
  admin: { components: ['AdminDashboard'], declares: null, reason: '編集' },
  general: { components: ['GeneralDashboard'], declares: null, reason: '編集' },
  it_tenko: { components: ['TenkoItAdminView'], declares: 'safe', by: 'TenkoItAdminView' },
}

/** 運行管理者のタブ (`ManagerDashboard.vue` の `TabKey`) */
const MANAGER_TABS: Record<string, Row> = {
  employees: { components: ['EmployeeList'], declares: null, reason: '編集' },
  license: { components: ['LicenseRegistration'], declares: null, reason: '登録' },
  tenko: { components: ['TenkoDashboardSummary', 'TenkoSessionMonitor'], declares: null, reason: '判定' },
  remote_tenko: { components: ['TenkoRemoteAdminView'], declares: 'safe', by: 'TenkoRemoteAdminView' },
  screen_share: { components: ['ScreenShareAdminView'], declares: null, reason: '視聴' },
  schedules: { components: ['TenkoScheduleManager'], declares: null, reason: '編集' },
  baselines: { components: ['HealthBaselineManager'], declares: null, reason: '編集' },
  failures: { components: ['EquipmentFailureManager'], declares: null, reason: '編集' },
  carrying_items: { components: ['CarryingItemsManager'], declares: null, reason: '編集' },
  work_hours: { components: ['WorkHoursViewer'], declares: null, reason: '閲覧' },
  timecard: { components: ['TimecardManager'], declares: null, reason: '編集' },
  devices: { components: ['DeviceRegistrationManager'], declares: null, reason: '設定' },
  it_guide: { components: ['ItTenkoGuide'], declares: null, reason: '印刷' },
}

// --- ソースからの取り出し ---

/** `type <name> = 'a' | 'b' | …` の値の一覧 */
function unionValues(src: string, name: string): string[] {
  const line = src.match(new RegExp(`type ${name} = ([^\\n]+)`))
  if (!line) throw new Error(`type ${name} が見つからない`)
  return [...line[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!)
}

/**
 * `v-if="<variable> === '<key>'"` を持つタグごとに、そこで載る component を取り出す。
 * タグ自身が component ならそれ 1 つ、素の要素 (`<div>`) なら次の `v-if` の手前までに在る component
 */
function componentsByKey(src: string, variable: string): Record<string, string[]> {
  const template = src.slice(src.indexOf('<template>'))
  const marks = [...template.matchAll(new RegExp(`<([A-Za-z][\\w-]*)\\s[^>]*?v-if="${variable} === '(\\w+)'"`, 'g'))]
  const result: Record<string, string[]> = {}
  marks.forEach((mark, i) => {
    const [, tag, key] = mark as unknown as [string, string, string]
    const isComponent = /^[A-Z]/.test(tag)
    const body = template.slice(mark.index! + mark[0].length, marks[i + 1]?.index ?? template.length)
    const found = isComponent ? [tag] : [...body.matchAll(/<([A-Z]\w*)/g)].map(m => m[1]!)
    result[key] = [...(result[key] ?? []), ...found]
  })
  return result
}

/** コメントを落とした script (`declareSafeToReload` に触れただけのコメントを呼び出しと数えない) */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const CALLS: Record<Exclude<Declares, null>, RegExp> = {
  track: /useKioskScreen\(\)\.track\(/,
  safe: /declareSafeToReload\(/,
}
const declaresAny = (code: string) => CALLS.track.test(code) || CALLS.safe.test(code)
const componentSource = (name: string) => codeOf(read(`components/${name}.vue`))

/** `app/` 配下の .vue / .ts を全部 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) ? [path] : []
  })
}

const indexSrc = read('pages/index.vue')
const managerSrc = read('components/ManagerDashboard.vue')
const allRows = [
  ...Object.values(DRIVER_TABS),
  ...Object.values(MANAGER_TABS),
  ...Object.values(ROLES).filter((r): r is Row => typeof r !== 'string'),
]

describe('新版への載せ替えの申告の配線 (Refs ippoan/alc-app#387)', () => {
  it('★ 役割 (pages/index.vue の RoleTab) は表と一致する — 増えたら表に足す', () => {
    expect(unionValues(indexSrc, 'RoleTab').sort()).toEqual(Object.keys(ROLES).sort())
  })

  it('★ 運行者のサブタブ (DriverSubTab) は表と一致する — 増えたら表に足す', () => {
    expect(unionValues(indexSrc, 'DriverSubTab').sort()).toEqual(Object.keys(DRIVER_TABS).sort())
  })

  it('★ 運行者のサブタブが載せる component は表と一致する', () => {
    const actual = componentsByKey(indexSrc, 'driverSubTab')
    expect(actual).toEqual(Object.fromEntries(Object.entries(DRIVER_TABS).map(([k, row]) => [k, row.components])))
  })

  it('★ 運行管理者のタブ (ManagerDashboard.vue の TabKey) は表と一致する — 増えたら表に足す', () => {
    expect(unionValues(managerSrc, 'TabKey').sort()).toEqual(Object.keys(MANAGER_TABS).sort())
  })

  it('★ 運行管理者のタブが載せる component は表と一致する', () => {
    const actual = componentsByKey(managerSrc, 'activeTab')
    expect(actual).toEqual(Object.fromEntries(Object.entries(MANAGER_TABS).map(([k, row]) => [k, row.components])))
  })

  it('★ 運行者以外の役割が載せる component は pages/index.vue に在る', () => {
    expect(indexSrc).toMatch(/<ManagerDashboard[\s/>]/)
    for (const row of Object.values(ROLES)) {
      if (typeof row === 'string') continue
      for (const name of row.components) expect(indexSrc, name).toMatch(new RegExp(`<${name}[\\s/>]`))
    }
  })

  it('★ 表の行は「申告する (どの component が)」か「申告しない (理由)」のどちらかを必ず持つ', () => {
    for (const row of allRows) {
      if (row.declares === null) {
        expect(row.reason, row.components.join()).toBeTruthy()
        expect(row.by).toBeUndefined()
      }
      else {
        expect(row.components, row.components.join()).toContain(row.by)
        expect(row.reason).toBeUndefined()
      }
    }
  })

  it('★ 「申告する」とした component のソースに、その申告の呼び出しが在る', () => {
    for (const row of allRows) {
      if (row.declares === null) continue
      expect(componentSource(row.by!), `${row.by} は ${row.declares} を申告するはず`).toMatch(CALLS[row.declares])
    }
  })

  it('★ 「申告しない」とした component は、自分では申告していない (足したら表を直す)', () => {
    for (const row of allRows) {
      if (row.declares !== null) continue
      for (const name of row.components) {
        expect(declaresAny(componentSource(name)), `${name} が申告している — 表の行を直す`).toBe(false)
      }
    }
  })

  it('★ 申告を呼んでいるファイルは、表に載っている component だけ (表の外で申告が増えたら落ちる)', () => {
    const declaring = sourceFiles(APP)
      .filter(path => !path.endsWith('composables/useKioskScreen.ts'))
      .filter(path => declaresAny(codeOf(readFileSync(path, 'utf-8'))))
      .map(path => relative(APP, path))
      .sort()
    const expected = [...new Set(allRows.filter(r => r.declares !== null).map(r => `components/${r.by}.vue`))].sort()
    expect(declaring).toEqual(expected)
  })
})

describe('配線テストの取り出し (取り出し方が壊れていないこと)', () => {
  it('union の値を取り出す', () => {
    expect(unionValues(`type T = 'a' | 'b_c'\nconst x = 'd'`, 'T')).toEqual(['a', 'b_c'])
    expect(() => unionValues('const x = 1', 'T')).toThrow('type T が見つからない')
  })

  it('タグ自身が component ならそれを、素の要素なら中の component を取り出す', () => {
    const src = `<script setup>const A = 1</script>
<template>
  <div>
    <Foo v-if="tab === 'a'" class="x" />
    <Foo v-if="tab === 'b'" :demo="true" />
    <div v-if="tab === 'c'" class="y">
      <Bar ref="bar" />
      <h2>見出し</h2>
      <Baz />
    </div>
    <Other />
  </div>
</template>`
    expect(componentsByKey(src, 'tab')).toEqual({ a: ['Foo'], b: ['Foo'], c: ['Bar', 'Baz', 'Other'] })
  })

  it('コメントの中の言及は呼び出しと数えない', () => {
    expect(declaresAny(codeOf('// useKioskScreen().declareSafeToReload(() => true)\nconst a = 1'))).toBe(false)
    expect(declaresAny(codeOf('/** declareSafeToReload( */\nconst a = 1'))).toBe(false)
    expect(declaresAny(codeOf('useKioskScreen().declareSafeToReload(() => true)'))).toBe(true)
    expect(declaresAny(codeOf('useKioskScreen().track(() => screen)'))).toBe(true)
  })
})
