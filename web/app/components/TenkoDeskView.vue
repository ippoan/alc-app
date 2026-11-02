<script setup lang="ts">
/**
 * 点呼受付: 遠隔点呼と IT点呼 を 1 つの画面で受ける (2026-11-02 ユーザー指示「IT点呼 画面の横に遠隔点呼をつくって
 * IT 遠隔 両方受けれるようにして」。将来 IT点呼 のタブはこちらへ寄せて消す)。
 *
 * 最上段の役割タブ `tenko_desk` に置く。IT点呼 と同じく**ログインなし** (`RoleAuthGate` を通さない) —
 * 遠隔点呼は通話前に指静脈で運行管理者を確かめ、IT点呼 は席に登録した運行管理者で判定する (今までどおり別々)。
 *
 * 2 つは同じマイク・カメラと指静脈の機器を使うので、片方が通話中・確認中の間はもう片方を止める
 * (`busy` を受けて相手に `blocked` を渡す)。
 */
const remoteBusy = ref(false)
const itBusy = ref(false)
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2" data-testid="tenko-desk">
    <section class="min-w-0 flex flex-col gap-2">
      <h2 class="text-base font-semibold text-gray-700">遠隔点呼</h2>
      <TenkoRemoteAdminView :blocked="itBusy" @busy="remoteBusy = $event" />
    </section>
    <section class="min-w-0 flex flex-col gap-2">
      <h2 class="text-base font-semibold text-gray-700">IT点呼</h2>
      <TenkoItAdminView :blocked="remoteBusy" @busy="itBusy = $event" />
    </section>
  </div>
</template>
