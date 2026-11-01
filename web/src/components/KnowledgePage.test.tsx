import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const caseA = {
  id: 'case-a',
  title: 'Pod OOMKilled 案例',
  problemType: 'OOMKilled',
  severity: 'p1' as const,
  summary: 'order-api 因内存不足反复 OOMKilled',
  rootCauses: ['内存 limit 过低'],
  solutions: ['上调 memory limit'],
  tags: ['auto_persisted'],
  createdAt: '2026-08-25T10:30:00Z',
  resolved: true,
}

vi.mock('../lib/api.js', () => ({
  listKnowledgeCases: vi.fn(async () => ({ cases: [caseA] })),
  searchKnowledgeCases: vi.fn(async () => ({ results: [] })),
  addKnowledgeCase: vi.fn(),
  fetchKnowledgeCase: vi.fn(async (id: string) => (id === caseA.id ? caseA : null)),
  deleteKnowledgeCase: vi.fn(async () => ({ ok: true })),
}))

import { KnowledgePage } from './KnowledgePage.js'
import { deleteKnowledgeCase, listKnowledgeCases } from '../lib/api.js'

describe('KnowledgePage', () => {
  const notify = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listKnowledgeCases).mockResolvedValue({ cases: [caseA] })
  })

  it('deletes a case from the card after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<KnowledgePage notify={notify} />)
    expect(await screen.findByText(caseA.title)).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: '删除' }))

    await waitFor(() => expect(deleteKnowledgeCase).toHaveBeenCalledWith(caseA.id, expect.any(Function)))
    expect(screen.queryByText(caseA.title)).not.toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith('案例已删除', 'success')
    confirmSpy.mockRestore()
  })

  it('keeps the case when the confirmation is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<KnowledgePage notify={notify} />)
    expect(await screen.findByText(caseA.title)).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: '删除' }))

    expect(deleteKnowledgeCase).not.toHaveBeenCalled()
    expect(screen.getByText(caseA.title)).toBeInTheDocument()
    confirmSpy.mockRestore()
  })
})
