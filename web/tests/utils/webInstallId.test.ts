import { describe, it, expect, beforeEach } from 'vitest'
import { getOrCreateWebInstallId } from '~/utils/webInstallId'

describe('getOrCreateWebInstallId', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('generates and persists a new id on first call', () => {
    const id = getOrCreateWebInstallId()
    expect(id).toBeTruthy()
    expect(localStorage.getItem('alc_web_install_id')).toBe(id)
  })

  it('returns the same id on subsequent calls', () => {
    const first = getOrCreateWebInstallId()
    const second = getOrCreateWebInstallId()
    expect(second).toBe(first)
  })
})
