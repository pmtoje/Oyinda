/** Thin API client: same-origin, cookie session, CSRF header on state-changing calls, typed errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public requestId?: string) { super(message); }
}

let csrf: string | undefined;
export const setCsrf = (t?: string) => { csrf = t; };

async function request<T>(method: string, url: string, body?: unknown, opts: { form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
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
  return json.data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
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

/** Open a document via a short-lived, single-use grant. */
export async function openDocument(documentId: string, disposition: 'inline' | 'attachment' = 'inline') {
  const g = await api.post<{ url: string }>(`/api/documents/${documentId}/grant`, { disposition });
  window.open(g.url, '_blank', 'noopener');
}

export const idem = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
