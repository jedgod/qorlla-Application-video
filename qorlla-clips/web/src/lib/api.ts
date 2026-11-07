// Typed client for the Clips API. Calls are same-origin (/api/*, forwarded by Next.js), so the Qorlla session cookie is sent automatically.

export type ClipSource = 'RECORDING' | 'AVATAR_GENERATION' | 'SLIDE_CONVERSION' | 'UPLOAD';
export type ClipStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface Clip {
  id: string; title: string; videoUrl: string | null; source: ClipSource; status: ClipStatus;
  isStarred: boolean; isTrashed: boolean; trashedAt: string | null; createdAt: string; updatedAt: string;
  ownedByMe: boolean; ownerName?: string | null;
  /** true when the clip has playable media (an uploaded recording or an external URL) */
  playable: boolean; sizeBytes: number | null; mimeType: string | null; durationMs: number | null;
}
export interface UploadPlan { partSize: number; totalParts: number }
export interface UploadState { status: ClipStatus; partSize: number; totalParts: number; uploadedParts: { partNumber: number; size: number }[] }
export interface PlaylistSummary { id: string; title: string; clipCount: number; isOrganization?: boolean }
export interface Summary {
  myClipsCount: number; starredCount: number; trashCount: number; sharedCount: number; unreadNotifications: number;
  playlists: PlaylistSummary[]; organizationPlaylists: PlaylistSummary[];
  organization: string; features: { upload: boolean }; role: 'MEMBER' | 'ADMIN';
}
export interface Me { id: string; name: string | null; email: string; role: 'MEMBER' | 'ADMIN' }
export interface Notice { id: string; type: string; message: string; clipId: string | null; read: boolean; createdAt: string }
export interface ClipQuery { view: 'recent' | 'mine' | 'starred' | 'trash' | 'shared' | 'playlist'; playlistId?: string; source?: ClipSource; q?: string; cursor?: string | null; limit?: number }

export class ApiError extends Error {
  status: number; code: string; feature?: string;
  constructor(status: number, code: string, message: string, feature?: string) { super(message); this.status = status; this.code = code; this.feature = feature; }
}

// Local development only: names the caller when the API runs with AUTH_MODE=dev. Production uses the Qorlla session cookie.
const DEV_USER = process.env.NEXT_PUBLIC_DEV_USER || '';
const DEV_ORG = process.env.NEXT_PUBLIC_DEV_ORG || '';
const DEV_ROLE = process.env.NEXT_PUBLIC_DEV_ROLE || '';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'qorlla-clips' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (DEV_USER) { headers['x-dev-user'] = DEV_USER; if (DEV_ORG) headers['x-dev-org'] = DEV_ORG; if (DEV_ROLE) headers['x-dev-role'] = DEV_ROLE; }
  let res: Response;
  try { res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
  catch { throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.'); }
  const data = await res.json().catch(() => null) as (Record<string, unknown> | null);
  if (!res.ok) throw new ApiError(res.status, String(data?.error ?? 'error'), String(data?.message ?? `Request failed (${res.status})`), data?.feature as string | undefined);
  return data as T;
}

const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface Overview {
  scope: 'organization' | 'mine'; days: number; generatedAt: string;
  totals: { clips: number; ready: number; storageBytes: number; clipsInPeriod: number; viewsInPeriod: number };
  clipsPerDay: { date: string; count: number }[]; viewsPerDay: { date: string; count: number }[];
  bySource: Record<string, number>; topClips: { id: string; title: string; views: number }[];
}
export interface AdminReport { id: string; reason: string; status: string; createdAt: string; clip: { id: string; title: string; isTrashed: boolean; ownerName: string } }

export const api = {
  overview: (days: number) => request<Overview>('GET', `/analytics/overview?days=${days}`),
  reportClip: (id: string, reason: string) => request<{ ok: true }>('POST', `/clips/${id}/report`, { reason }),
  adminReports: () => request<{ reports: AdminReport[] }>('GET', '/admin/reports'),
  resolveReport: (id: string, action: 'dismiss' | 'trash') => request<{ id: string; status: string }>('POST', `/admin/reports/${id}/resolve`, { action }),
  auditLog: () => request<{ entries: { id: string; action: string; actorId: string; clipId: string | null; detail: string | null; createdAt: string }[] }>('GET', '/admin/audit'),
  /** downloads the PDF through fetch so the same headers/cookies as every other call are used */
  reportPdf: async (days: number, title: string): Promise<Blob> => {
    const headers: Record<string, string> = {};
    if (DEV_USER) { headers['x-dev-user'] = DEV_USER; if (DEV_ORG) headers['x-dev-org'] = DEV_ORG; if (DEV_ROLE) headers['x-dev-role'] = DEV_ROLE; }
    let res: Response;
    try { res = await fetch(`/api/analytics/report.pdf${qs({ days, title })}`, { headers, cache: 'no-store' }); }
    catch { throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.'); }
    if (!res.ok) throw new ApiError(res.status, 'error', `Could not create the report (${res.status}).`);
    return res.blob();
  },
  me: () => request<Me>('GET', '/me'),
  summary: () => request<Summary>('GET', '/navigation/summary'),
  clips: (q: ClipQuery) => request<{ clips: Clip[]; nextCursor: string | null }>('GET', `/clips${qs({ ...q })}`),
  createClip: (b: { source: ClipSource; title?: string; playlistId?: string }) => request<Clip>('POST', '/clips', b),
  patchClip: (id: string, b: { title?: string; isStarred?: boolean }) => request<Clip>('PATCH', `/clips/${id}`, b),
  trashClip: (id: string) => request<Clip>('POST', `/clips/${id}/trash`),
  restoreClip: (id: string) => request<Clip>('POST', `/clips/${id}/restore`),
  deleteClip: (id: string) => request<{ ok: true }>('DELETE', `/clips/${id}`),
  shareClip: (id: string, email: string) => request<{ ok: true }>('POST', `/clips/${id}/share`, { email }),
  playlists: (scope: 'mine' | 'organization') => request<{ playlists: PlaylistSummary[] }>('GET', `/playlists${qs({ scope })}`),
  createPlaylist: (title: string, isOrganization = false) => request<PlaylistSummary>('POST', '/playlists', { title, isOrganization }),
  renamePlaylist: (id: string, title: string) => request<PlaylistSummary>('PATCH', `/playlists/${id}`, { title }),
  deletePlaylist: (id: string) => request<{ ok: true }>('DELETE', `/playlists/${id}`),
  addToPlaylist: (playlistId: string, clipId: string) => request<{ ok: true }>('POST', `/playlists/${playlistId}/clips`, { clipId }),
  removeFromPlaylist: (playlistId: string, clipId: string) => request<{ ok: true }>('DELETE', `/playlists/${playlistId}/clips/${clipId}`),
  // ---- recordings: the browser uploads the file in parts straight to object storage with short-lived signed URLs ----
  startRecording: (b: { title?: string; source?: 'RECORDING' | 'UPLOAD'; mimeType: string; sizeBytes: number; durationMs?: number }) => request<{ clip: Clip; upload: UploadPlan }>('POST', '/recordings', b),
  uploadState: (id: string) => request<UploadState>('GET', `/clips/${id}/upload`),
  signParts: (id: string, partNumbers: number[]) => request<{ urls: Record<string, string>; expiresInSeconds: number }>('POST', `/clips/${id}/upload/parts`, { partNumbers }),
  completeUpload: (id: string) => request<{ clip: Clip }>('POST', `/clips/${id}/upload/complete`, {}),
  abortUpload: (id: string) => request<{ ok: true }>('POST', `/clips/${id}/upload/abort`, {}),
  playback: (id: string) => request<{ url: string; expiresInSeconds: number; mimeType: string | null }>('GET', `/clips/${id}/playback`),
  notifications: () => request<{ notifications: Notice[] }>('GET', '/notifications'),
  markNotificationsRead: () => request<{ updated: number }>('POST', '/notifications/read', {}),
};
