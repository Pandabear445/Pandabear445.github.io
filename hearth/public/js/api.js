// REST client.
let token = localStorage.getItem('hearth.token') || '';

export const getToken = () => token;
export function setToken(t) {
  token = t || '';
  if (token) localStorage.setItem('hearth.token', token);
  else localStorage.removeItem('hearth.token');
}

export async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch('/api' + path, opts);
  let data = {};
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const e = new Error(data.error || `Request failed (${r.status})`);
    e.status = r.status;
    e.code = data.code;
    e.retryAfter = Number(r.headers.get('Retry-After')) || 0; // seconds, on 429
    throw e;
  }
  return data;
}

// Upload with progress (fetch has no upload progress).
export function upload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(formData);
  });
}
