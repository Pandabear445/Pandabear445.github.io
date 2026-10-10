// Decrypted attachments are kept as blob: URLs so scrolling back past a picture doesn't download and decrypt it
// again. Without a limit, a long session kept every file it ever opened in memory. This keeps the most recently
// used `keep` of them and frees older ones, but never one that's still on screen or still being decrypted.

export function createBlobCache({ keep = 150, inUse = () => new Set(), revoke = (url) => URL.revokeObjectURL(url) } = {}) {
  const jobs = new Map(); // key -> Promise<url>, least recently used first
  const urls = new Map(); // key -> url, once decrypted

  function trim() {
    if (jobs.size <= keep) return;
    const shown = inUse();
    for (const key of [...jobs.keys()]) {
      if (jobs.size <= keep) break;
      const url = urls.get(key);
      if (!url || shown.has(url)) continue;
      jobs.delete(key);
      urls.delete(key);
      revoke(url);
    }
  }

  return {
    // The URL for `key`, made by `make()` (a promise of a blob: URL) the first time. A failed `make` isn't
    // remembered, so the next try starts over.
    get(key, make) {
      let job = jobs.get(key);
      if (job) jobs.delete(key);
      else {
        job = make();
        job.then((url) => { if (jobs.get(key) === job) urls.set(key, url); else revoke(url); }, () => { if (jobs.get(key) === job) jobs.delete(key); });
      }
      jobs.set(key, job);
      trim();
      return job;
    },
    // Forget `key` (a retry after a failed load); its URL is freed unless something still shows it.
    delete(key) {
      const url = urls.get(key);
      jobs.delete(key);
      urls.delete(key);
      if (url && !inUse().has(url)) revoke(url);
    },
    get size() { return jobs.size; },
    trim,
  };
}

// The blob: URLs the page shows right now (pictures, video, audio, links).
export function blobUrlsInPage(doc = document) {
  const out = new Set();
  for (const el of doc.querySelectorAll('img[src^="blob:"], video[src^="blob:"], audio[src^="blob:"], source[src^="blob:"], a[href^="blob:"]')) {
    out.add(el.getAttribute('src') || el.getAttribute('href'));
  }
  return out;
}
