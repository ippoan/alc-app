import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoDeskView from '~/components/TenkoDeskView.vue'

// 点呼受付: 遠隔点呼と IT点呼 を並べ、片方の busy を相手の blocked に渡す (中身は各画面のテスト)
const stubs = {
  TenkoRemoteAdminView: { name: 'TenkoRemoteAdminView', props: ['blocked'], emits: ['busy'], template: '<div data-testid="remote" />' },
  TenkoItAdminView: { name: 'TenkoItAdminView', props: ['blocked'], emits: ['busy'], template: '<div data-testid="it" />' },
}

describe('TenkoDeskView', () => {
  it('★ 遠隔点呼と IT点呼 を並べ、片方が busy の間は相手を blocked にする', async () => {
    const w = await mountSuspended(TenkoDeskView, { global: { stubs } })
    const remote = w.findComponent({ name: 'TenkoRemoteAdminView' })
    const it_ = w.findComponent({ name: 'TenkoItAdminView' })
    expect(w.text()).toContain('遠隔点呼')
    expect(w.text()).toContain('IT点呼')
    expect(remote.props('blocked')).toBe(false)
    expect(it_.props('blocked')).toBe(false)
    remote.vm.$emit('busy', true)
    await w.vm.$nextTick()
    expect(it_.props('blocked')).toBe(true)
    expect(remote.props('blocked')).toBe(false)
    remote.vm.$emit('busy', false)
    it_.vm.$emit('busy', true)
    await w.vm.$nextTick()
    expect(it_.props('blocked')).toBe(false)
    expect(remote.props('blocked')).toBe(true)
    w.unmount()
  })
})
