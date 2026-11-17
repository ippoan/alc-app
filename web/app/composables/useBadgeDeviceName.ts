/**
 * 右下の版の表示 (`app.vue` の `VersionBadge`) に出す「このページがつかんでいる機体の名前」
 * (Refs ippoan/alc-app-s3#352)。どの PC にどの端末が繋がっているかを画面で見分けるため。
 *
 * - 指静脈端末: 版の報告 (`useVeinFirmwareReport`) が送った端末の id (キオスクの鍵、無ければ運行管理者席の鍵の
 *   token の `sub`) → 鍵のラベル。引けなければ `Vein Station <指紋 8 字>` (`veinDeviceLabel`)
 * - CoreS3: 版の報告 (`useFirmwareReport`) が `AUTH STATUS` で聞いた id → 端末の表示名 (`nameOf`)
 *
 * **token も `AUTH STATUS` もここでは取りに行かない** — 報告が既に持っている id を読むだけ。報告がまだ
 * 送れていない (token が無い等) ・繋がっていない機体は出さない (報告の id は切断で null に戻る)。名前の表は id が出たときに読む
 * (どちらも無い画面では名前の API を叩かない。前に失敗していれば読み直す — `loadDeviceNames`)。
 */
import { reportedCoreS3DeviceId, reportedVeinDeviceId } from '~/utils/reported-device-id'
import { veinDeviceLabel } from '~/utils/vein-device-label'

/** 指静脈端末と CoreS3 の名前を 1 行にする。どちらも無ければ null (項目ごと出さない) */
export function badgeDeviceText(veinName: string | null, coreS3Name: string | null): string | null {
  const names = [veinName, coreS3Name].filter((n): n is string => !!n)
  return names.length > 0 ? names.join(' / ') : null
}

export function useBadgeDeviceName() {
  // 接続は報告の id で見る (どちらも切断で null)。ここで useVeinSerial / useCoreS3Serial を生成しない —
  // 全画面の根 (app.vue) の setup で生成すると、機体の口の初期化を画面の描画に巻き込む
  const veinId = reportedVeinDeviceId
  const coreS3Id = reportedCoreS3DeviceId
  const names = shallowRef<ReturnType<typeof useDeviceNames> | null>(null)

  watch([veinId, coreS3Id], ([v, c]) => {
    if (!v && !c) return
    if (names.value) void loadDeviceNames()
    else names.value = useDeviceNames()
  }, { immediate: true })

  return computed(() => {
    // 名前の表は id が初めて出たときに生成する (それまでは出す機体も無い)
    const n = names.value
    if (!n) return null
    const v = veinId.value
    const c = coreS3Id.value
    return badgeDeviceText(
      v ? veinDeviceLabel(v, n.keyLabelOf(v)) : null,
      c ? n.nameOf(c) : null,
    )
  })
}
