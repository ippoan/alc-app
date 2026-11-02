/**
 * 開発端末の「ファームの配信の合図を購読できているか」(Refs ippoan/alc-app-s3#352)。
 *
 * 書くのは `DevFirmwareAutoUpdate.vue`、出すのは `app.vue` の右下の版の表示 (`VersionBadge` の slot)。
 * 版の表示に重ねて別の帯を出すと版が見えなくなるため、同じ部品の中に入れる。開発端末でなければ null
 */
export interface DevFirmwareWatchBadge {
  /** 購読がつながっているか */
  on: boolean
  /** 短い状態 (購読中 / 再接続中 / 未購読) */
  text: string
  /** 最後に合図を受けた時刻 (HH:MM:SS)。まだ無ければ null */
  lastSignalAt: string | null
}

export function useDevFirmwareWatchBadge() {
  return useState<DevFirmwareWatchBadge | null>('dev-firmware-watch-badge', () => null)
}
