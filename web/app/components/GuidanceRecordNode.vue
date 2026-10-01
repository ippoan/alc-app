<script setup lang="ts">
import type { GuidanceRecord } from '~/types'
import { selectSendToken } from '~/utils/token-selection'

const props = defineProps<{
  record: GuidanceRecord
  depth: number
  expandedIds: Set<string>
  uploadingId: string | null
}>()

const emit = defineEmits<{
  toggle: [id: string]
  addChild: [rec: { id: string; title: string }]
  delete: [id: string]
  upload: [recordId: string, event: Event]
  deleteAttachment: [recordId: string, attachmentId: string]
}>()

const GUIDANCE_TYPES: Record<string, { label: string; color: string }> = {
  general: { label: '一般', color: 'bg-blue-100 text-blue-700' },
  safety: { label: '安全運転', color: 'bg-green-100 text-green-700' },
  legal: { label: '法令遵守', color: 'bg-yellow-100 text-yellow-700' },
  skill: { label: '技能向上', color: 'bg-purple-100 text-purple-700' },
  other: { label: 'その他', color: 'bg-gray-100 text-gray-600' },
}

const hasChildren = computed(() => props.record.children && props.record.children.length > 0)
const isExpanded = computed(() => props.expandedIds.has(props.record.id))
const depthColors = ['border-blue-400', 'border-green-400', 'border-orange-400']
const borderColor = computed(() => depthColors[props.depth] || 'border-gray-300')

const config = useRuntimeConfig()
const { accessToken, deviceTenantId } = useAuth()

// 認証付きで添付ファイルを取得してblob URLに変換
const blobUrls = ref<Record<string, string>>({})

async function loadAttachmentBlob(att: { id: string; record_id: string; file_type: string }) {
  const key = att.id
  if (blobUrls.value[key]) return
  try {
    const headers: Record<string, string> = {}
    // 付けるトークンは api.ts と同じ規則で選ぶ (Refs ippoan/alc-app#387)。ここは管理者の口なので
    // 端末の getter は渡さない — dev端末では管理者のトークンを付けずに送る (本番の行を読まない)
    const token = await selectSendToken(accessToken.value, 'kiosk', null)
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (deviceTenantId.value) headers['X-Tenant-ID'] = deviceTenantId.value
    const res = await fetch(`${config.public.apiBase}/api/guidance-records/${att.record_id}/attachments/${att.id}`, { headers })
    if (!res.ok) return
    const blob = await res.blob()
    blobUrls.value[key] = URL.createObjectURL(blob)
  } catch {}
}

function attachmentUrl(att: { id: string; record_id: string; file_type: string }) {
  loadAttachmentBlob(att)
  return blobUrls.value[att.id] || ''
}

function isImage(type: string) { return type.startsWith('image/') }

onUnmounted(() => {
  for (const url of Object.values(blobUrls.value)) URL.revokeObjectURL(url)
})

function formatDate(d: string) {
  return new Date(d).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatFileSize(size: number | null) {
  if (!size) return ''
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}
</script>

<template>
  <div :class="depth > 0 ? 'ml-6' : ''">
    <!-- Record Card -->
    <div
      class="border rounded-lg p-3 transition-colors"
      :class="[
        depth > 0 ? `border-l-4 ${borderColor}` : 'border-gray-200',
        hasChildren ? 'cursor-pointer hover:bg-gray-50' : '',
      ]"
    >
      <!-- Header -->
      <div class="flex items-start justify-between gap-2">
        <div class="flex-1" @click="hasChildren ? emit('toggle', record.id) : undefined">
          <div class="flex items-center gap-2 mb-1">
            <!-- Expand arrow -->
            <button
              v-if="hasChildren || (record.children?.length === 0 && record.depth < 2)"
              class="text-gray-400 hover:text-gray-600 w-5 flex-shrink-0"
              @click.stop="emit('toggle', record.id)"
            >
              <svg class="w-4 h-4 transition-transform" :class="isExpanded ? 'rotate-90' : ''" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" />
              </svg>
            </button>
            <span v-else class="w-5 flex-shrink-0" />

            <span class="font-medium text-sm">{{ record.title }}</span>
            <span class="text-xs px-1.5 py-0.5 rounded" :class="GUIDANCE_TYPES[record.guidance_type]?.color || 'bg-gray-100 text-gray-600'">
              {{ GUIDANCE_TYPES[record.guidance_type]?.label || record.guidance_type }}
            </span>
            <span v-if="hasChildren" class="text-xs text-gray-400">({{ record.children!.length }})</span>
          </div>
          <div class="text-xs text-gray-500 flex items-center gap-3 flex-wrap ml-5">
            <span>{{ record.employee_name || '-' }}</span>
            <span v-if="record.guided_by">指導: {{ record.guided_by }}</span>
            <span>{{ formatDate(record.guided_at) }}</span>
          </div>
          <div v-if="record.content" class="mt-1 text-sm text-gray-700 whitespace-pre-wrap ml-5">{{ record.content }}</div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-1 shrink-0 text-xs">
          <button
            v-if="record.depth < 2"
            class="text-blue-600 hover:bg-blue-50 px-2 py-1 rounded"
            @click="emit('addChild', { id: record.id, title: record.title })"
          >+子記録</button>
          <label class="text-gray-500 hover:bg-gray-100 px-2 py-1 rounded cursor-pointer">
            <span v-if="uploadingId === record.id">...</span>
            <span v-else>添付</span>
            <input
              type="file"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
              class="hidden"
              :disabled="uploadingId === record.id"
              @change="emit('upload', record.id, $event)"
            />
          </label>
          <button class="text-gray-400 hover:text-red-600 px-2 py-1 rounded" @click="emit('delete', record.id)">削除</button>
        </div>
      </div>

      <!-- Attachments -->
      <div v-if="record.attachments && record.attachments.length > 0" class="mt-2 ml-5 flex flex-wrap gap-2">
        <div
          v-for="att in record.attachments"
          :key="att.id"
          class="flex items-center gap-1 bg-gray-50 border rounded px-2 py-1 text-xs group"
        >
          <template v-if="isImage(att.file_type)">
            <img :src="attachmentUrl(att)" class="w-8 h-8 object-cover rounded" />
          </template>
          <template v-else>
            <svg class="w-4 h-4 text-red-500" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" />
            </svg>
          </template>
          <a :href="attachmentUrl(att)" target="_blank" class="text-blue-600 hover:underline truncate max-w-[120px]">
            {{ att.file_name }}
          </a>
          <span class="text-gray-400">{{ formatFileSize(att.file_size) }}</span>
          <button
            class="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
            @click="emit('deleteAttachment', record.id, att.id)"
          >&#10005;</button>
        </div>
      </div>
    </div>

    <!-- Children (recursive) -->
    <div v-if="isExpanded && record.children && record.children.length > 0" class="mt-1 space-y-1">
      <GuidanceRecordNode
        v-for="child in record.children"
        :key="child.id"
        :record="child"
        :depth="depth + 1"
        :expanded-ids="expandedIds"
        :uploading-id="uploadingId"
        @toggle="(id: string) => emit('toggle', id)"
        @add-child="(rec: { id: string; title: string }) => emit('addChild', rec)"
        @delete="(id: string) => emit('delete', id)"
        @upload="(recordId: string, event: Event) => emit('upload', recordId, event)"
        @delete-attachment="(recordId: string, attId: string) => emit('deleteAttachment', recordId, attId)"
      />
    </div>
  </div>
</template>
