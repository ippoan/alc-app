/**
 * USB で挿す機体 (CoreS3・血圧測定台の ATOM S3・Vein Station) を、**機能ごとの組**で返す
 * (Refs ippoan/alc-app#436)。
 *
 * 3 機種のファームは alc-app-s3 の hub-drivers を共有していて、同じ語彙の行を出す
 * (`EVT NFC_LICENSE …` / `EVT FC1200 …` / `{"type":"alcohol",…}` / `{"type":"temperature",…}`)。
 * 画面は「どの機体か」ではなく「NFC を読める機体がつながっているか」「アルコールチェッカーを
 * つないだ機体がつながっているか」で分岐すれば、Vein Station も CoreS3 と同じ表示・処理に乗る。
 *
 * | 組 | 機体 (優先順) |
 * |---|---|
 * | `nfc` | CoreS3 → ATOM S3 → Vein Station |
 * | `alcohol` | CoreS3 → Vein Station |
 * | `thermo` | CoreS3 → Vein Station |
 *
 * 組が画面ごとに違うので 1 本の `isConnected` にしない (測定台の ATOM S3 は FC-1200 をつながない)。
 * 両方つながる構成は無い前提だが、重なったら CoreS3 を優先する (useNfcReader の従来の規則)。
 *
 * **ここが持たないもの:**
 * - **ポートの connect / release。** 掴むのは各機体の利用側 (useDeviceToken / useBpStationDeviceToken /
 *   useBleGateway)。Vein Station のポートは指静脈と端末の鍵で共有しているので、release すると
 *   鍵のキャッシュが捨てられ指静脈も止まる (useBleGateway の transports に Vein を入れない理由と同じ)
 * - **署名先の選択。** useDeviceToken は「Vein がつながっていれば Vein だけ」で、優先順が逆
 * - CoreS3 にしか無い機能 (画面への STAGE 出力・carins・hub claim・血圧計ボンドの署名・
 *   ファーム報告の帯・IC カードの打刻)。それぞれの composable が CoreS3 を直接見る
 */

import type { SerialJsonHandler } from '~/utils/serial-line-dispatch'

/** 機体の種類。値は `NfcReadSource` の USB 直結のものと同じ語彙 */
export type UsbHubKind = 'cores3' | 'bp-station' | 'vein-station'

export interface UsbHubDevice {
  kind: UsbHubKind
  /** 画面に出す機体名 */
  label: string
}

/** `source` はどの機体から来た行か (束ねたあとでは判別できないので渡す) */
export type UsbHubEventHandler = (name: string, args: string[], source: UsbHubKind) => void

/** 機体 1 台ぶんの、ここが使う口 (useCoreS3Serial / useAtomS3Serial / useVeinSerial の共通部分) */
interface UsbHubMember extends UsbHubDevice {
  isConnected: Readonly<Ref<boolean>>
  onEvent: (cb: (name: string, args: string[]) => void) => () => void
  onJson: (cb: SerialJsonHandler) => void
}

function role(members: UsbHubMember[]) {
  /** つながっている機体 (優先順) */
  const connected = computed<UsbHubDevice[]>(() =>
    members.filter(m => m.isConnected.value).map(m => ({ kind: m.kind, label: m.label })),
  )
  /** 今つながっている機体のうち優先順で先頭。無ければ null */
  const device = computed<UsbHubDevice | null>(() => connected.value[0] ?? null)

  return {
    connected,
    device,
    label: computed(() => device.value?.label ?? null),
    isConnected: computed(() => device.value !== null),
    /** 組の全機体の `EVT` を受ける (つながっていない機体は鳴らないだけ)。返り値で全部解除 */
    onEvent(cb: UsbHubEventHandler): () => void {
      const offs = members.map(m => m.onEvent((name, args) => cb(name, args, m.kind)))
      return () => { for (const off of offs) off() }
    },
    /** 組の全機体の JSON を受ける (解除の口は無い。各機体の onJson と同じ) */
    onJson(cb: SerialJsonHandler): void {
      for (const m of members) m.onJson(cb)
    },
  }
}

export type UsbHubRole = ReturnType<typeof role>

export function useUsbHub() {
  const core = useCoreS3Serial()
  const atom = useAtomS3Serial()
  const vein = useVeinSerial()

  const cores3: UsbHubMember = { kind: 'cores3', label: 'CoreS3', isConnected: core.isConnected, onEvent: core.onEvent, onJson: core.onJson }
  const bpStation: UsbHubMember = { kind: 'bp-station', label: 'ATOM S3', isConnected: atom.isConnected, onEvent: atom.onEvent, onJson: atom.onJson }
  const veinStation: UsbHubMember = { kind: 'vein-station', label: 'Vein Station', isConnected: vein.isConnected, onEvent: vein.onEvent, onJson: vein.onJson }

  return {
    nfc: role([cores3, bpStation, veinStation]),
    alcohol: role([cores3, veinStation]),
    thermo: role([cores3, veinStation]),
  }
}
