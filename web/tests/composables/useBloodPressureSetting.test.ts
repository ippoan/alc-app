import { describe, it, expect, beforeEach } from 'vitest'
import { useBloodPressureSetting } from '~/composables/useBloodPressureSetting'

describe('useBloodPressureSetting — 血圧計を使うかの受け口は 1 本 (Refs ippoan/alc-app-s3#135)', () => {
  beforeEach(() => {
    useBloodPressureSetting().setBpEnabled(false)
  })

  it('サーバ設定が届くまでの既定は false (血圧計を繋いでいない端末)', () => {
    expect(useBloodPressureSetting().bpEnabled.value).toBe(false)
  })

  it('setBpEnabled で流し込んだ値を、別の呼び出し元も同じように見る', () => {
    const a = useBloodPressureSetting()
    const b = useBloodPressureSetting()
    a.setBpEnabled(true)
    expect(a.bpEnabled.value).toBe(true)
    expect(b.bpEnabled.value).toBe(true)

    b.setBpEnabled(false)
    expect(a.bpEnabled.value).toBe(false)
  })
})
