import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cancelSession } from './api.js'

describe('cancelSession', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('POSTs to the session cancel endpoint and returns the interrupt flags', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, interrupted: true, changed: true }),
    })

    const res = await cancelSession('s-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s-1/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(res).toEqual({ ok: true, interrupted: true, changed: true })
  })

  it('escapes the session id in the path', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, interrupted: false, changed: false }) })

    await cancelSession('a/b c')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/a%2Fb%20c/cancel', expect.anything())
  })

  it('surfaces failures through the error callback', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'session not found' })
    const onError = vi.fn()

    const res = await cancelSession('missing', onError)

    expect(res).toBeUndefined()
    expect(onError).toHaveBeenCalledWith({ message: '404: session not found', status: 404 })
  })
})
