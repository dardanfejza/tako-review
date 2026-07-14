import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/apiClient';
import type { MeResponse, ProfileUpdate } from '../types/api';

export const authKeys = { me: ['me'] as const };

/** GET /api/auth/me, mapping a 401 to a null (signed-out) principal (API §5.2). */
export function useMe() {
  return useQuery<MeResponse | null>({
    queryKey: authKeys.me,
    queryFn: async () => {
      try {
        return await api.getMe();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
  });
}

export function useGuest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.guest(),
    onSuccess: (me) => qc.setQueryData(authKeys.me, me),
  });
}

/** PATCH /api/auth/me — partial profile update (ui_language, telemetry_opt_out). The returned
 *  MeResponse replaces the cached principal so consumers see the new value immediately. */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileUpdate) => api.patchMe(body),
    onSuccess: (me) => qc.setQueryData(authKeys.me, me),
  });
}

/** Back-compat alias — LocaleProvider's ui_language mirror predates the generic name. */
export const useUpdateLanguage = useUpdateProfile;

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => qc.setQueryData(authKeys.me, null),
  });
}
