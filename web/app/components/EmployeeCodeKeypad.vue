<script setup lang="ts">
/**
 * 社員番号のキーパッド。端末のキーボードを出さないよう input 要素にせず、表示だけにする。
 * 打った番号は親が `v-model` で持つ (親が「次の人へ」で消す)。決定で `submit` を出す。
 * 指静脈の登録 (`VeinRegistration`) と血圧測定 (`BloodPressureMeasurement`) の入口が使う
 */
const code = defineModel<string>({ default: '' })
const emit = defineEmits<{ submit: [code: string] }>()
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const
</script>

<template>
  <div>
    <div data-testid="code-display" class="h-12 mb-2 px-4 flex items-center justify-center border border-gray-300 rounded-xl text-2xl font-mono tracking-widest text-gray-800">
      {{ code }}
    </div>
    <div class="grid grid-cols-3 gap-2">
      <button
        v-for="k in KEYS"
        :key="k"
        :data-key="k"
        class="py-3 bg-gray-100 rounded-xl text-xl font-medium text-gray-800 hover:bg-gray-200"
        @click="code += k"
      >
        {{ k }}
      </button>
      <button data-key="clear" class="py-3 bg-gray-100 rounded-xl text-sm text-gray-600 hover:bg-gray-200" @click="code = ''">
        全部消す
      </button>
      <button data-key="0" class="py-3 bg-gray-100 rounded-xl text-xl font-medium text-gray-800 hover:bg-gray-200" @click="code += '0'">
        0
      </button>
      <button data-key="back" class="py-3 bg-gray-100 rounded-xl text-sm text-gray-600 hover:bg-gray-200" @click="code = code.slice(0, -1)">
        1 文字消す
      </button>
    </div>
    <button
      data-key="submit"
      class="w-full mt-2 px-4 py-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
      :disabled="!code"
      @click="emit('submit', code)"
    >
      決定
    </button>
  </div>
</template>
