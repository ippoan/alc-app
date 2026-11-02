import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TenkoCompleted from '~/components/TenkoCompleted.vue'
import type { TenkoSession } from '~/types'

function session(status: TenkoSession['status']): TenkoSession {
  return {
    id: 'sess-1',
    tenko_type: 'pre_operation',
    status,
    responsible_manager_name: '運行 管理者',
    started_at: '2026-10-29T00:00:00Z',
    completed_at: status === 'completed' ? '2026-10-29T00:10:00Z' : null,
    alcohol_value: 0,
    temperature: null,
    systolic: null,
    diastolic: null,
  } as unknown as TenkoSession
}

describe('TenkoCompleted — 遠隔点呼の判定待ち (Refs ippoan/rust-alc-api#680)', () => {
  it('判定待ちは「入力完了」と判定を待っている旨を出す', async () => {
    const w = await mountSuspended(TenkoCompleted, { props: { session: session('judgment_pending'), employeeName: '点呼 太郎' } })
    expect(w.find('h3').text()).toBe('入力完了')
    expect(w.find('[data-testid="judgment-pending"]').text()).toContain('運行管理者の判定を待っています')
  })

  it('完了は今までどおり「点呼完了」で、判定待ちの表示は出ない', async () => {
    const w = await mountSuspended(TenkoCompleted, { props: { session: session('completed'), employeeName: '点呼 太郎' } })
    expect(w.find('h3').text()).toBe('点呼完了')
    expect(w.find('[data-testid="judgment-pending"]').exists()).toBe(false)
  })

  it('判定で閉じた点呼は運行管理者の判定 (NG は理由も) と、次の点呼へ移るまでの残り秒数を出す', async () => {
    const ok = await mountSuspended(TenkoCompleted, {
      props: { session: { ...session('completed'), manager_judgment: 'ok' }, employeeName: '点呼 太郎', autoResetSeconds: 12 },
    })
    expect(ok.find('[data-testid="manager-judgment"]').text()).toBe('運行管理者の判定: OK')
    expect(ok.find('[data-testid="auto-reset-countdown"]').text()).toBe('あと 12 秒で次の点呼へ移ります')
    const ng = await mountSuspended(TenkoCompleted, {
      props: { session: { ...session('completed'), manager_judgment: 'ng', manager_judgment_reason: '顔色が悪い' }, employeeName: '点呼 太郎' },
    })
    expect(ng.find('[data-testid="manager-judgment"]').text()).toBe('運行管理者の判定: NG (顔色が悪い)')
    expect(ng.find('[data-testid="auto-reset-countdown"]').exists()).toBe(false)
    const pending = await mountSuspended(TenkoCompleted, {
      props: { session: { ...session('judgment_pending'), manager_judgment: null }, employeeName: '点呼 太郎' },
    })
    expect(pending.find('[data-testid="manager-judgment"]').exists()).toBe(false)
  })
})
