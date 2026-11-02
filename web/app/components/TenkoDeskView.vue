<script setup lang="ts">
/**
 * 点呼受付: 遠隔点呼と IT点呼 を 1 つの画面で受ける (2026-11-02 ユーザー指示。将来 IT点呼 のタブはこちらへ寄せて消す)。
 *
 * 画面は IT点呼 の受け画面 (`TenkoItAdminView`) そのもので、着信の一覧に遠隔点呼の部屋も「遠隔」の行として並べる
 * (「行で IT か遠隔かわかればよくね」)。遠隔の行の「通話する」は、埋め込んだ `TenkoRemoteAdminView` (自前の一覧は
 * 出さない) が受け持つ — 通話前の指静脈の確認・全画面の通話・判定は今までの遠隔点呼と同じ。
 *
 * 最上段の役割タブ `tenko_desk` に置く。IT点呼 と同じく**ログインなし**。判定者は今までどおり別々
 * (IT点呼 は席に登録した運行管理者、遠隔点呼は通話前に指静脈で確かめた運行管理者)。
 *
 * 2 つは同じマイク・カメラと指静脈の機器を使うので、片方が通話中・確認中の間はもう片方を止める
 * (`busy` を受けて相手に `blocked` を渡す)。
 */
import { splitRooms } from '~/utils/it-tenko'

const { activeRooms } = useActiveRooms()
const remoteRooms = computed(() => splitRooms(activeRooms.value).remote)
const remoteBusy = ref(false)
const itBusy = ref(false)
const remote = ref<{ requestCall: (roomId: string) => void } | null>(null)
</script>

<template>
  <div data-testid="tenko-desk">
    <TenkoRemoteAdminView ref="remote" embedded :blocked="itBusy" @busy="remoteBusy = $event" />
    <TenkoItAdminView
      :blocked="remoteBusy"
      :remote-rooms="remoteRooms"
      @busy="itBusy = $event"
      @remote-call="roomId => remote?.requestCall(roomId)"
    />
  </div>
</template>
