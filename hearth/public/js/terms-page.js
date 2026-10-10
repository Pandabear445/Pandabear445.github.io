// Public /terms page: shows this server's Terms of Service.
import { renderDoc } from './markdown.js';
const main = document.querySelector('main');
fetch('/api/terms').then((r) => r.json()).then((t) => {
  main.innerHTML = `<div class="md">${renderDoc(t.text)}</div><p class="muted-p"><a href="/">\u2190 Back to the app</a></p>`;
}).catch(() => { main.textContent = 'Could not load the terms.'; });
