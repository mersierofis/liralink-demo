import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from './client'
import type { AuthResult, Merchant } from './types'

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
