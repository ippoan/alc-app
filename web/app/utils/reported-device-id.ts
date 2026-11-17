import { ref } from 'vue'

/**
 * 版の報告が使っている機体の id (Refs ippoan/alc-app-s3#352)。書くのは `useFirmwareReport` /
 * `useVeinFirmwareReport` だけで、右下の版の表示 (`useBadgeDeviceName`) は読むだけ。
 *
 * 報告の composable 本体から切り離してあるのは、版の表示 (app.vue) から読むときに報告側の依存
 * (token の取得・書き込み・署名) を読み込ませないため。
 */

/** いま繋がっている CoreS3 の id (`AUTH STATUS` で聞いた値。切断で null — 更新中は持ったまま) */
export const reportedCoreS3DeviceId = ref<string | null>(null)

/** 最後に報告した指静脈端末の id (端末の token の `sub` から作った値)。切断で null */
export const reportedVeinDeviceId = ref<string | null>(null)
