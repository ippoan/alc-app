// ページの読み込み直し (USB の OTA の後・画面からの再起動の後)
import { describe, it, expect, vi } from 'vitest'
import { reloadPage } from '~/utils/page-reload'

describe('reloadPage', () => {
  it('location.reload を呼ぶ', () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    try {
      reloadPage()
      expect(reload).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
