// Reading answers from other servers without trusting their size. A fetch() body read with arrayBuffer() sits in
// memory whole before anything can check how big it is, so one huge (or endless) answer from a GIF or picture host
// could fill this server's memory. readLimited reads it piece by piece and hangs up as soon as it passes the limit.

// The whole body as a Buffer, or null if it's bigger than max bytes (the connection is closed early then).
async function readLimited(res, max) {
  const len = +(res.headers.get('content-length') || 0);
  if (len > max) { await cancel(res.body); return null; }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
// Lets go of a body we won't read (a redirect, an error page), so the connection isn't left waiting.
async function cancel(body) {
  try { if (body) await body.cancel(); } catch { /* already closed */ }
}

module.exports = { readLimited, cancel };
