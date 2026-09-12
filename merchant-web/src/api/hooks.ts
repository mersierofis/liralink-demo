import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'

import { apiRequest } from './client'
import type { AuthResult, LinkStatus, Merchant, Paginated, PaymentLink } from './types'

export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiRequest<Merchant>('/me'),
    enabled,
  })
}

export function useLogin() {
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiRequest<AuthResult>('/auth/login', { method: 'POST', body, auth: false }),
  })
}

export function useRegister() {
  return useMutation({
    mutationFn: (body: { email: string; password: string; businessName: string }) =>
      apiRequest<AuthResult>('/auth/register', { method: 'POST', body, auth: false }),
  })
}

export function useUpdateMe() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { businessName?: string; iban?: string; autoSavePercent?: number }) =>
      apiRequest<Merchant>('/me', { method: 'PATCH', body }),
    onSuccess: (merchant) => {
      queryClient.setQueryData(['me'], merchant)
    },
  })
}

export interface LinksFilter {
  status?: LinkStatus | 'all'
  page?: number
  limit?: number
}

export function useLinks(filters: LinksFilter = {}) {
  const params = new URLSearchParams()
  if (filters.status && filters.status !== 'all') params.set('status', filters.status)
  if (filters.page) params.set('page', String(filters.page))
  if (filters.limit) params.set('limit', String(filters.limit))
  const qs = params.toString()

  return useQuery({
    queryKey: ['links', filters],
    queryFn: () => apiRequest<Paginated<PaymentLink>>(`/links${qs ? `?${qs}` : ''}`),
  })
}

export function useLink(
  id: string | undefined,
  opts: { refetchInterval?: UseQueryOptions<PaymentLink>['refetchInterval'] } = {},
) {
  return useQuery({
    queryKey: ['links', id],
    queryFn: () => apiRequest<PaymentLink>(`/links/${id}`),
    enabled: !!id,
    refetchInterval: opts.refetchInterval,
  })
}

export function useCreateLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { title: string; description?: string; amountTRY: string; expiresInHours?: number }) =>
      apiRequest<PaymentLink>('/links', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['links'] })
    },
  })
}

export function useCancelLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiRequest<PaymentLink>(`/links/${id}/cancel`, { method: 'POST' }),
    onSuccess: (link) => {
      queryClient.invalidateQueries({ queryKey: ['links'] })
      queryClient.setQueryData(['links', link.id], link)
    },
  })
}
