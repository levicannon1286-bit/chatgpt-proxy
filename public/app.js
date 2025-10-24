// public/app.js
// If you host frontend separately (e.g., tiiny.host), set PROXY_BASE to your Netlify site's base URL (e.g., "https://your-site.netlify.app")
const PROXY_BASE = ''; // leave empty for relative "/.netlify/functions/proxy"
const urlInput = document.getElementById('urlInput');
const goBtn = document.getElementById('goBtn');
const openBtn = document.getElementById('openBtn');
const keyInput = document.getElementById('keyInput');
const frame = document.getElementById('frame');
const displayMode = document.getElementById('displayMode');

function buildProxyLink(targetUrl, key) {
  const base = PROXY_BASE || '/.netlify/functions/proxy';
  const encoded = encodeURIComponent(targetUrl);
  const url = `${base}?url=${encoded}`;
  return key ? `${url}&key=${encodeURIComponent(key)}` : url;
}

goBtn.addEventListener('click', () => {
  const target = urlInput.value.trim();
  if (!target) return alert('Enter a URL (include https://)');
  const link = buildProxyLink(target, keyInput.value.trim());
  frame.src = link;
});

openBtn.addEventListener('click', () => {
  const target = urlInput.value.trim();
  if (!target) return alert('Enter a URL');
  const link = buildProxyLink(target, keyInput.value.trim());
  if (displayMode.value === 'newtab') {
    window.open(link, '_blank');
  } else {
    frame.src = link;
    // scroll to viewer
    frame.scrollIntoView({ behavior: 'smooth' });
  }
});

// quick paste sample
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    urlInput.focus();
  }
});
