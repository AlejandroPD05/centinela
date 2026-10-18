import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type {
  ApiKey,
  AuditEntry,
  Channel,
  ChannelType,
  DailyBucket,
  DeliveryRow,
  IncidentRecord,
  IncidentRow,
  Member,
  MonitorCreateInput,
  MonitorDetail,
  MonitorPatchInput,
  MonitorView,
  CheckRow,
  Role,
  UptimeSummary,
  UptimeWindowName,
  Workspace,
} from './types';

/** Cadencia de refresco del panel: la consola se mira, no se adora. */
const LIVE_MS = 10_000;
const DETAIL_MS = 15_000;
const STATS_MS = 30_000;

export const qk = {
  monitors: (workspaceId: string | null) => ['monitors', workspaceId] as const,
  monitor: (id: string) => ['monitor', id] as const,
  uptime: (id: string, window: UptimeWindowName) => ['uptime', id, window] as const,
  history: (id: string, days: number) => ['history', id, days] as const,
  checks: (id: string, limit: number) => ['checks', id, limit] as const,
  monitorIncidents: (id: string) => ['monitor-incidents', id] as const,
  incidents: (workspaceId: string | null) => ['incidents', workspaceId] as const,
  channels: (workspaceId: string | null) => ['channels', workspaceId] as const,
  deliveries: (workspaceId: string | null, status: string) =>
    ['deliveries', workspaceId, status] as const,
  members: (workspaceId: string) => ['members', workspaceId] as const,
  apiKeys: () => ['api-keys'] as const,
  audit: (workspaceId: string | null) => ['audit', workspaceId] as const,
};

// ── Lecturas ─────────────────────────────────────────────────────────────────

export function useMonitors(workspaceId: string | null) {
  return useQuery({
    queryKey: qk.monitors(workspaceId),
    queryFn: async () =>
      (
        await api<{ monitors: MonitorView[] }>('/monitors', {
          query: { workspaceId: workspaceId ?? undefined },
        })
      ).monitors,
    refetchInterval: LIVE_MS,
  });
}

export function useMonitor(id: string | undefined) {
  return useQuery({
    queryKey: qk.monitor(id ?? ''),
    // Este endpoint responde el monitor a secas (los de escritura lo envuelven).
    queryFn: () => api<MonitorDetail>(`/monitors/${id}`),
    enabled: id !== undefined && id !== '',
    refetchInterval: DETAIL_MS,
  });
}

export function useUptime(id: string | undefined, window: UptimeWindowName) {
  return useQuery({
    queryKey: qk.uptime(id ?? '', window),
    queryFn: () => api<UptimeSummary>(`/monitors/${id}/uptime`, { query: { window } }),
    enabled: id !== undefined && id !== '',
    refetchInterval: STATS_MS,
  });
}

export function useHistory(id: string | undefined, days = 90) {
  return useQuery({
    queryKey: qk.history(id ?? '', days),
    queryFn: async () =>
      (
        await api<{ days: number; buckets: DailyBucket[] }>(`/monitors/${id}/history`, {
          query: { days },
        })
      ).buckets,
    enabled: id !== undefined && id !== '',
    refetchInterval: STATS_MS,
  });
}

export function useChecks(id: string | undefined, limit = 30) {
  return useQuery({
    queryKey: qk.checks(id ?? '', limit),
    queryFn: async () =>
      (await api<{ checks: CheckRow[] }>(`/monitors/${id}/checks`, { query: { limit } })).checks,
    enabled: id !== undefined && id !== '',
    refetchInterval: DETAIL_MS,
  });
}

export function useMonitorIncidents(id: string | undefined, limit = 20) {
  return useQuery({
    queryKey: qk.monitorIncidents(id ?? ''),
    queryFn: async () =>
      (
        await api<{ incidents: IncidentRecord[] }>(`/monitors/${id}/incidents`, {
          query: { limit },
        })
      ).incidents,
    enabled: id !== undefined && id !== '',
    refetchInterval: DETAIL_MS,
  });
}

export function useIncidents(workspaceId: string | null) {
  return useQuery({
    queryKey: qk.incidents(workspaceId),
    queryFn: async () =>
      (
        await api<{ incidents: IncidentRow[] }>('/incidents', {
          query: { workspaceId: workspaceId ?? undefined },
        })
      ).incidents,
    refetchInterval: LIVE_MS,
  });
}

export function useChannels(workspaceId: string | null) {
  return useQuery({
    queryKey: qk.channels(workspaceId),
    queryFn: async () => {
      const all = (await api<{ channels: Channel[] }>('/channels')).channels;
      return workspaceId === null
        ? all
        : all.filter((channel) => channel.workspaceId === workspaceId);
    },
  });
}

export function useDeliveries(workspaceId: string | null, status = '') {
  return useQuery({
    queryKey: qk.deliveries(workspaceId, status),
    queryFn: async () =>
      (
        await api<{ deliveries: DeliveryRow[] }>('/deliveries', {
          query: { workspaceId: workspaceId ?? undefined, status: status || undefined },
        })
      ).deliveries,
    refetchInterval: LIVE_MS,
  });
}

export function useMembers(workspaceId: string) {
  return useQuery({
    queryKey: qk.members(workspaceId),
    queryFn: async () =>
      (await api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`)).members,
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: qk.apiKeys(),
    queryFn: async () => (await api<{ apiKeys: ApiKey[] }>('/api-keys')).apiKeys,
  });
}

export function useAudit(workspaceId: string | null) {
  return useQuery({
    queryKey: qk.audit(workspaceId),
    queryFn: async () =>
      (
        await api<{ entries: AuditEntry[] }>('/audit', {
          query: { workspaceId: workspaceId ?? undefined },
        })
      ).entries,
  });
}

// ── Escrituras ───────────────────────────────────────────────────────────────

function useInvalidate() {
  const client = useQueryClient();
  return (keys: ReadonlyArray<ReadonlyArray<unknown>>) => {
    for (const key of keys) void client.invalidateQueries({ queryKey: key });
  };
}

export function useCreateMonitor() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: MonitorCreateInput) =>
      (await api<{ monitor: MonitorDetail }>('/monitors', { method: 'POST', body: input })).monitor,
    onSuccess: (monitor) => {
      invalidate([qk.monitors(monitor.workspaceId), qk.monitor(monitor.id)]);
    },
  });
}

export function useUpdateMonitor(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: MonitorPatchInput) =>
      (await api<{ monitor: MonitorDetail }>(`/monitors/${id}`, { method: 'PATCH', body: input }))
        .monitor,
    onSuccess: (monitor) => {
      invalidate([qk.monitors(monitor.workspaceId), qk.monitor(monitor.id)]);
    },
  });
}

export function useDeleteMonitor() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/monitors/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate([['monitors']]),
  });
}

export function useCheckNow() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string }>(`/monitors/${id}/check`, { method: 'POST' }),
    onSuccess: () => invalidate([['monitors']]),
  });
}

export interface ChannelInput {
  type: ChannelType;
  workspaceId: string;
  name: string;
  config: Record<string, unknown>;
}

export function useCreateChannel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: ChannelInput) =>
      (await api<{ channel: Channel }>('/channels', { method: 'POST', body: input })).channel,
    onSuccess: (channel) => invalidate([qk.channels(channel.workspaceId)]),
  });
}

export function useUpdateChannel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      workspaceId: string;
      name?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }) =>
      (
        await api<{ channel: Channel }>(`/channels/${input.id}`, {
          method: 'PATCH',
          body: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.config !== undefined ? { config: input.config } : {}),
          },
        })
      ).channel,
    onSuccess: (channel) => invalidate([qk.channels(channel.workspaceId)]),
  });
}

export function useDeleteChannel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate([['channels']]),
  });
}

export function useTestChannel() {
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string }>(`/channels/${id}/test`, { method: 'POST' }),
  });
}

export function useAddMember(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { email: string; role: Role }) =>
      (
        await api<{ member: Member }>(`/workspaces/${workspaceId}/members`, {
          method: 'POST',
          body: input,
        })
      ).member,
    onSuccess: () => invalidate([qk.members(workspaceId)]),
  });
}

export function useSetMemberRole(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      api<{ member: { userId: string; role: Role } }>(
        `/workspaces/${workspaceId}/members/${input.userId}`,
        {
          method: 'PATCH',
          body: { role: input.role },
        },
      ),
    onSuccess: () => invalidate([qk.members(workspaceId)]),
  });
}

export function useRemoveMember(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => invalidate([qk.members(workspaceId)]),
  });
}

export function useCreateApiKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { name: string; expiresInDays?: number }) =>
      api<{ key: string; apiKey: ApiKey }>('/api-keys', { method: 'POST', body: input }),
    onSuccess: () => invalidate([qk.apiKeys()]),
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate([qk.apiKeys()]),
  });
}

export function useCreateWorkspace() {
  return useMutation({
    mutationFn: async (name: string) =>
      (await api<{ workspace: Workspace }>('/workspaces', { method: 'POST', body: { name } }))
        .workspace,
  });
}
