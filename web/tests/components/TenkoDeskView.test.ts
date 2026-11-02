import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import TenkoDeskView from '~/components/TenkoDeskView.vue'

// 点呼受付: IT点呼 の画面の着信の一覧に遠隔点呼の部屋も渡し、遠隔の行は埋め込んだ遠隔点呼の画面へ回す。
// 片方の busy を相手の blocked に渡す (中身は各画面のテスト)
const rooms = ref<string[]>(['it-session-1', 'session-2', 'screen-x'])
mockNuxtImport('useActiveRooms', () => () => ({ activeRooms: rooms }))

const requestCall = vi.fn()
const stubs = {
  TenkoRemoteAdminView: {
    name: 'TenkoRemoteAdminView',
    props: ['blocked', 'embedded'],
    emits: ['busy'],
    setup(_: unknown, { expose }: { expose: (o: object) => void }) { expose({ requestCall }) },
    template: '<div data-testid="remote" />',
  },
  TenkoItAdminView: { name: 'TenkoItAdminView', props: ['blocked', 'remoteRooms'], emits: ['busy', 'remoteCall'], template: '<div data-testid="it" />' },
}

describe('TenkoDeskView', () => {
  it('★ IT点呼 の画面に遠隔の部屋を渡し、遠隔の行の「通話する」は埋め込んだ遠隔点呼へ回す', async () => {
    const w = await mountSuspended(TenkoDeskView, { global: { stubs } })
    const remote = w.findComponent({ name: 'TenkoRemoteAdminView' })
    const it_ = w.findComponent({ name: 'TenkoItAdminView' })
    expect(remote.props('embedded')).not.toBe(false)
    // 画面共有と IT の部屋は渡さない (IT は IT点呼 の画面が自分で引く)
    expect(it_.props('remoteRooms')).toEqual(['session-2'])
    it_.vm.$emit('remoteCall', 'session-2')
    expect(requestCall).toHaveBeenCalledWith('session-2')
    w.unmount()
  })

  it('★ 片方が busy の間は相手を blocked にする', async () => {
    const w = await mountSuspended(TenkoDeskView, { global: { stubs } })
    const remote = w.findComponent({ name: 'TenkoRemoteAdminView' })
    const it_ = w.findComponent({ name: 'TenkoItAdminView' })
    expect(remote.props('blocked')).toBe(false)
    expect(it_.props('blocked')).toBe(false)
    remote.vm.$emit('busy', true)
    await w.vm.$nextTick()
    expect(it_.props('blocked')).toBe(true)
    remote.vm.$emit('busy', false)
    it_.vm.$emit('busy', true)
    await w.vm.$nextTick()
    expect(it_.props('blocked')).toBe(false)
    expect(remote.props('blocked')).toBe(true)
    w.unmount()
  })
})
