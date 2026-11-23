const S4E_URL = 'https://redesaude.s4e.com.br/SYS/';
const S4E_PATTERN = 'https://redesaude.s4e.com.br/*';
const PORTAL_URL = 'https://192.168.1.11:5443/';
const PORTAL_PATTERNS = [
  'http://192.168.1.11/*',
  'https://192.168.1.11/*',
  'http://127.0.0.1/*',
  'https://127.0.0.1/*',
  'http://localhost/*',
  'https://localhost/*',
];

async function openOrFocus(patterns, url) {
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (tabs.length) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
        return;
      }
    } catch (_) {}
  }
  await chrome.tabs.create({ url });
}

document.getElementById('openS4e').addEventListener('click', () => openOrFocus([S4E_PATTERN], S4E_URL));
document.getElementById('openPortal').addEventListener('click', () => openOrFocus(PORTAL_PATTERNS, PORTAL_URL));
