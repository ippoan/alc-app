/**
 * 右下の版の表示 (`app.vue` の `VersionBadge`) に出す「このページがつかんでいる機体の名前と id」
 * (Refs ippoan/alc-app-s3#352)。どの PC にどの端末が繋がっているかを画面で見分けるため。
 *
 * - 指静脈端末: 版の報告 (`useVeinFirmwareReport`) が送った端末の id (キオスクの鍵、無ければ運行管理者席の鍵の
 *   token の `sub`) → 名前。引けなければ `Vein Station <指紋 8 字>` (`veinDeviceLabel`)
 * - CoreS3: 版の報告 (`useFirmwareReport`) が `AUTH STATUS` で聞いた id → 名前。引けなければ「名前未登録の端末」
 *
 * 名前は「自分の端末 1 台の名前」の口 (`getDeviceName` → `/api/device-name`) で **id ごとに 1 回**引いて覚える。
 * 名前の一覧 (`useDeviceNames`) は管理者だけなので、運行管理者席・キオスクの画面では引けないため使わない。
 * 失敗した id は覚えず、次に id が変わったときに引き直す。
 *
 * **token も `AUTH STATUS` もここでは取りに行かない** — 報告が既に持っている id を読むだけ。報告がまだ
 * 送れていない (token が無い等) ・繋がっていない機体は出さない (報告の id は切断で null に戻る)。
 */
import { getDeviceName } from '~/utils/api'
import { UNNAMED_DEVICE } from '~/utils/device-name'
import { reportedCoreS3DeviceId, reportedVeinDeviceId } from '~/utils/reported-device-id'
import { shortDeviceId } from '~/utils/short-device-id'
import { veinDeviceLabel } from '~/utils/vein-device-label'

/** 版の表示に出す機体 1 台 (名前と id) */
export interface BadgeDevice {
  name: string
  id: string
}

/** 版の表示の「端末: …」の中身。`text` は id を短縮した表示、`title` は id の全文 (ホバー) */
export interface BadgeDeviceText {
  text: string
  title: string
}

/**
 * 指静脈端末と CoreS3 を 1 行にする (各名前の後ろに id を括弧で。短縮は「端末のファーム」一覧と同じ
 * `shortDeviceId`)。どちらも無ければ null (項目ごと出さない)
 */
export function badgeDeviceText(vein: BadgeDevice | null, coreS3: BadgeDevice | null): BadgeDeviceText | null {
  const devices = [vein, coreS3].filter((d): d is BadgeDevice => !!d)
  if (devices.length === 0) return null
  return {
    text: devices.map(d => `${d.name} (${shortDeviceId(d.id)})`).join(' / '),
    title: devices.map(d => `${d.name} (${d.id})`).join(' / '),
  }
}

export function useBadgeDeviceName() {
  // 接続は報告の id で見る (どちらも切断で null)。ここで useVeinSerial / useCoreS3Serial を生成しない —
  // 全画面の根 (app.vue) の setup で生成すると、機体の口の初期化を画面の描画に巻き込む
  const veinId = reportedVeinDeviceId
  const coreS3Id = reportedCoreS3DeviceId
  /** 引けた名前 (id → 名前。名前の無い端末は null)。失敗した id は入れない */
  const names = ref<Record<string, string | null>>({})
  const inFlight = new Set<string>()

  async function load(id: string): Promise<void> {
    if (Object.hasOwn(names.value, id) || inFlight.has(id)) return
    inFlight.add(id)
    try {
      const { name } = await getDeviceName(id)
      names.value = { ...names.value, [id]: name }
    }
    catch {
      // 覚えない (次に id が変わったときに引き直す)
    }
    finally {
      inFlight.delete(id)
    }
  }

  watch([veinId, coreS3Id], ([v, c]) => {
    if (v) void load(v)
    if (c) void load(c)
  }, { immediate: true })

  return computed(() => {
    const v = veinId.value
    const c = coreS3Id.value
    return badgeDeviceText(
      v ? { name: veinDeviceLabel(v, names.value[v]), id: v } : null,
      c ? { name: names.value[c] ?? UNNAMED_DEVICE, id: c } : null,
    )
  })
}
