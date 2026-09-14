import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MeasurementFacePhoto from '~/components/MeasurementFacePhoto.vue'
import type { ApiMeasurement } from '~/types'

// MeasurementDetail.vue から分離 (Refs #238, #259, ippoan/alc-app-s3#135)。
// face_photo_url がある測定だけ fetchFacePhoto を呼んで <img> を出す。

const fetchFacePhotoMock = vi.fn(async () => null as string | null)

vi.mock('~/utils/api', () => ({
  fetchFacePhoto: (...args: any[]) => fetchFacePhotoMock(...args),
}))

/** onMounted の await 群を流し切る */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function baseMeasurement(overrides: Partial<ApiMeasurement> = {}): ApiMeasurement {
  return {
    id: 'm-1',
    tenant_id: 't-1',
    employee_id: 'emp-1',
    alcohol_value: 0,
    result_type: 'normal',
    device_use_count: 1,
    measured_at: '2026-09-12T00:33:00Z',
    created_at: '2026-09-12T00:33:00Z',
    updated_at: '2026-09-12T00:33:00Z',
    status: 'completed',
    ...overrides,
  }
}

describe('MeasurementFacePhoto — 顔写真の表示', () => {
  beforeEach(() => {
    fetchFacePhotoMock.mockClear()
    fetchFacePhotoMock.mockResolvedValue(null)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:http://localhost/photo'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('face_photo_url がある測定では fetchFacePhoto を id で呼び <img> を出す', async () => {
    fetchFacePhotoMock.mockResolvedValueOnce('blob:http://localhost/photo')
    const wrapper = await mountSuspended(MeasurementFacePhoto, {
      props: { measurement: baseMeasurement({ face_photo_url: 'https://example.com/photo.jpg' }) },
    })
    await flush()
    expect(fetchFacePhotoMock).toHaveBeenCalledWith('m-1')
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('blob:http://localhost/photo')
    wrapper.unmount()
  })

  it('face_photo_url が無い測定では fetchFacePhoto を呼ばず「顔認証なし」を出す', async () => {
    const wrapper = await mountSuspended(MeasurementFacePhoto, {
      props: { measurement: baseMeasurement({ face_photo_url: undefined }) },
    })
    await flush()
    expect(fetchFacePhotoMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('顔認証なし')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(false)
    wrapper.unmount()
  })

  it('face_photo_url はあるが読み込めなかった測定ではプレースホルダを出し「顔認証なし」は出さない', async () => {
    fetchFacePhotoMock.mockResolvedValueOnce(null)
    const wrapper = await mountSuspended(MeasurementFacePhoto, {
      props: { measurement: baseMeasurement({ face_photo_url: 'https://example.com/photo.jpg' }) },
    })
    await flush()
    expect(fetchFacePhotoMock).toHaveBeenCalledWith('m-1')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('顔認証なし')
    wrapper.unmount()
  })

  it('unmount で顔写真の object URL を revoke する', async () => {
    fetchFacePhotoMock.mockResolvedValueOnce('blob:http://localhost/photo')
    const wrapper = await mountSuspended(MeasurementFacePhoto, {
      props: { measurement: baseMeasurement({ face_photo_url: 'https://example.com/photo.jpg' }) },
    })
    await flush()
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/photo')
  })

  it('unmount 後に fetch が resolve したら revoke され img は出ない', async () => {
    let resolveFetch!: (v: string | null) => void
    fetchFacePhotoMock.mockImplementationOnce(() => new Promise(resolve => { resolveFetch = resolve }))
    const wrapper = await mountSuspended(MeasurementFacePhoto, {
      props: { measurement: baseMeasurement({ face_photo_url: 'https://example.com/photo.jpg' }) },
    })
    wrapper.unmount()
    resolveFetch('blob:http://localhost/photo')
    await flush()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/photo')
  })
})
