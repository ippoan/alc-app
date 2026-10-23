<script setup lang="ts">
/**
 * 全端末の指静脈の一覧の、キオスク側の受け答え (Refs ippoan/alc-app#436)。
 *
 * 運行者の画面にタブに関係なく常に在る (FirmwareOtaHost と同じ置き場)。管理者が一覧の画面で
 * 「最新を取る」を押すと、recorder が購読 WS に `vein_list_request` の合図を送る。受けたら
 * このブラウザの対応表 (IndexedDB の `module_ids`) とモジュールの登録人数を報告する。
 * 生体データ (記録の中身) は送らない。描くものは無い。
 *
 * 購読は Vein Station が最初に繋がった時点で 1 回だけ張り、以後は張りっぱなし
 * (一度も繋いでいないブラウザは対応表を持たないので張らない)。
 *
 * **Vein Station を掴みに行くのもここ** — 掴むのが血圧・点呼の画面だけだと、管理者の画面に
 * 切り替えたブラウザでは Station が繋がらず、その鍵で端末の token も取れない
 * (CoreS3 の無い PC では Vein Station が端末の鍵。`useDeviceToken` の vein の署名)。
 */
import { reportVeinFleet } from '~/utils/api'
import { loadVeinModuleEntries } from '~/utils/vein-db'

const props = defineProps<{
  /** いまのタブがデモか。デモの間は合図を受けても報告しない */
  demo?: boolean
}>()

const veinSerial = useVeinSerial()

async function report(): Promise<void> {
  try {
    const entries = await loadVeinModuleEntries()
    // 登録人数は読めた回だけ載せる (外れていても対応表は送る)
    const info = veinSerial.isConnected.value ? await veinSerial.syncInfo().catch(() => null) : null
    await reportVeinFleet({
      entries: entries.map(e => ({
        module_id: e.moduleId,
        employee_id: e.employeeId,
        approved: e.approved,
        version: e.updatedAt,
        ...(e.registeredDeviceId ? { registered_device_id: e.registeredDeviceId } : {}),
      })),
      ...(info ? { module_users: info.users, module_max: info.max } : {}),
    })
  }
  catch (e) {
    console.warn('[vein-fleet] 対応表を報告できませんでした:', e)
  }
}

const fleetWatch = useTimecardWatch({
  getToken: () => useDeviceToken().getDeviceJwt(),
  onVeinListRequest: () => {
    if (!props.demo) void report()
  },
})

onMounted(() => { void veinSerial.connect() })

let subscribed = false
watch(veinSerial.isConnected, (connected) => {
  if (!connected || subscribed) return
  subscribed = true
  void fleetWatch.connect()
}, { immediate: true })
</script>

<template>
  <!-- 描くものは無い -->
</template>
