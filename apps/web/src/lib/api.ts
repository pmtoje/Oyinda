/** Thin API client: same-origin, cookie session, CSRF header on state-changing calls, typed errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public requestId?: string) { super(message); }
}

let csrf: string | undefined;
export const setCsrf = (t?: string) => { csrf = t; };

async function request<T>(method: string, url: string, body?: unknown, opts: { form?: FormData; passive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Passive = background refresh: authenticated, but does not count as user activity for the inactivity timeout.
  if (opts.passive) headers['x-gz-passive'] = '1';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let payload: BodyInit | undefined;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const json = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    const e = json?.error ?? {};
    if (res.status === 401 && !url.startsWith('/api/auth/') && !url.startsWith('/api/onboarding/')) window.dispatchEvent(new CustomEvent('gz:unauthorized'));
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'The request could not be completed.', e.details, e.requestId);
  }
  if (json?.data?.csrfToken) csrf = json.data.csrfToken;
  if (!opts.passive && !url.startsWith('/api/auth/session/')) window.dispatchEvent(new CustomEvent('gz:activity'));
  return json.data as T;
}

export const api = {
  get: <T = any>(url: string, opts: { passive?: boolean } = {}) => request<T>('GET', url, undefined, opts),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  upload: <T = any>(url: string, file: File, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file);
    return request<T>('POST', url, undefined, { form });
  },
};

/**
 * Upload with real progress (fetch cannot report upload progress). Same session cookie and CSRF header as every other
 * request; resolves only when the server has stored the file, so the UI never shows success early.
 */
export function uploadWithProgress<T = any>(url: string, file: File, onProgress: (fraction: number) => void, fields: Record<string, string> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(0.99, e.loaded / e.total)); };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'The upload was interrupted. Check your connection and try again.'));
    xhr.onload = () => {
      let json: any = {};
      try { json = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        window.dispatchEvent(new CustomEvent('gz:activity'));
        resolve(json.data as T);
      } else {
        const e = json?.error ?? {};
        if (xhr.status === 401) window.dispatchEvent(new CustomEvent('gz:unauthorized'));
        reject(new ApiError(xhr.status, e.code ?? 'ERROR', e.message ?? 'The upload could not be completed.', e.details, e.requestId));
      }
    };
    xhr.send(form);
  });
}

/** Open a document via a short-lived, single-use grant. */
export async function openDocument(documentId: string, disposition: 'inline' | 'attachment' = 'inline') {
  const g = await api.post<{ url: string }>(`/api/documents/${documentId}/grant`, { disposition });
  window.open(g.url, '_blank', 'noopener');
}

export const idem = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
