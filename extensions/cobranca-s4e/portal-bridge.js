// Ponte entre a tela de Cobrança do portal e a extensão.
(function () {
  const SESSION_KEY = 'portal-session-v1';

  function markReady() {
    document.documentElement.dataset.cobrancaExtension = '1';
    window.dispatchEvent(new CustomEvent('cobranca-extension-ready'));
  }

  function session() {
    let user = null;
    try { user = JSON.parse(localStorage.getItem('portal-user-v1') || 'null'); } catch (_) {}
    return {
      token: localStorage.getItem(SESSION_KEY) || '',
      origin: location.origin,
      userId: user && user.id ? user.id : '',
      userName: user && (user.displayName || user.display_name || user.username) || '',
    };
  }

  window.addEventListener('portal-cobranca-import', () => {
    try {
      chrome.runtime.sendMessage({ type: 'PORTAL_IMPORT_REQUEST' });
    } catch (_) {}
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;
    if (message.type === 'GET_PORTAL_SESSION') {
      sendResponse(session());
      return;
    }
    if (message.type === 'COBRANCA_PROGRESS') {
      window.dispatchEvent(new CustomEvent('portal-cobranca-progress', { detail: { message: message.message || '' } }));
      return;
    }
    if (message.type === 'COBRANCA_RESULT') {
      window.dispatchEvent(new CustomEvent('portal-cobranca-result', { detail: message.detail || {} }));
    }
  });

  markReady();
  try {
    chrome.runtime.sendMessage({ type: 'PORTAL_READY' });
  } catch (_) {}
})();
