import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MeasurementDetail from '~/components/MeasurementDetail.vue'
import type { ApiMeasurement } from '~/types'

// 測定詳細に録画を再生する (Refs #238, ippoan/alc-app-s3#135)。
// video_url がある測定だけ fetchMeasurementVideo を呼んで <video> を出す。

const fetchFacePhotoMock = vi.fn(async () => null as string | null)
const fetchMeasurementVideoMock = vi.fn(async () => null as string | null)

vi.mock('~/utils/api', () => ({
  fetchFacePhoto: (...args: any[]) => fetchFacePhotoMock(...args),
  fetchMeasurementVideo: (...args: any[]) => fetchMeasurementVideoMock(...args),
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

describe('MeasurementDetail — 録画の再生', () => {
  beforeEach(() => {
    fetchFacePhotoMock.mockClear()
    fetchFacePhotoMock.mockResolvedValue(null)
    fetchMeasurementVideoMock.mockClear()
    fetchMeasurementVideoMock.mockResolvedValue(null)
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:http://localhost/video'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('video_url がある測定では fetchMeasurementVideo を呼び <video> を出す', async () => {
    fetchMeasurementVideoMock.mockResolvedValueOnce('blob:http://localhost/video')
    const wrapper = await mountSuspended(MeasurementDetail, {
      props: { measurement: baseMeasurement({ video_url: 'https://example.com/video.webm' }), employeeName: '山田太郎' },
    })
    await flush()
    expect(fetchMeasurementVideoMock).toHaveBeenCalledWith('m-1')
    const video = wrapper.find('video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toBe('blob:http://localhost/video')
    wrapper.unmount()
  })

  it('video_url が無い測定では fetchMeasurementVideo を呼ばず <video> も出さない', async () => {
    const wrapper = await mountSuspended(MeasurementDetail, {
      props: { measurement: baseMeasurement({ video_url: null }), employeeName: '山田太郎' },
    })
    await flush()
    expect(fetchMeasurementVideoMock).not.toHaveBeenCalled()
    expect(wrapper.find('video').exists()).toBe(false)
    wrapper.unmount()
  })

  it('取得に失敗 (null) したら「録画を読み込めませんでした」を出す', async () => {
    fetchMeasurementVideoMock.mockResolvedValueOnce(null)
    const wrapper = await mountSuspended(MeasurementDetail, {
      props: { measurement: baseMeasurement({ video_url: 'https://example.com/video.webm' }), employeeName: '山田太郎' },
    })
    await flush()
    expect(wrapper.text()).toContain('録画を読み込めませんでした')
    expect(wrapper.find('video').exists()).toBe(false)
    wrapper.unmount()
  })

  it('unmount で動画の object URL を revoke する', async () => {
    fetchMeasurementVideoMock.mockResolvedValueOnce('blob:http://localhost/video')
    const wrapper = await mountSuspended(MeasurementDetail, {
      props: { measurement: baseMeasurement({ video_url: 'https://example.com/video.webm' }), employeeName: '山田太郎' },
    })
    await flush()
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/video')
  })
})
