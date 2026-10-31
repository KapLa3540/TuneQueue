/* TuneQueue popup: настройки + лог событий из storage. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const channelInput = $('channel');
  const enabledBox = $('enabled');

  const STATUS_TEXT = {
    joined: ['ok', 'бот в чате'],
    joining: ['warn', 'заходим в чат…'],
    failed: ['bad', 'канал не найден?'],
    none: ['warn', 'канал не задан'],
  };

  function render(status, events) {
    // чипы
    const chips = $('chips');
    chips.innerHTML = '';
    const st = status || {};
    const [cls, text] = STATUS_TEXT[st.joinState || 'none'] || STATUS_TEXT.none;
    chips.innerHTML +=
      '<span class="chip ' + cls + '">' + text + (st.channel ? ' #' + st.channel : '') + '</span>';
    if (st.busy) chips.innerHTML += '<span class="chip warn">ставим трек…</span>';
    if (st.pending) chips.innerHTML += '<span class="chip warn">в очереди: ' + st.pending + '</span>';

    // поле канала не трогаем, если в нём фокус
    if (document.activeElement !== channelInput) {
      channelInput.value = st.channel || '';
    }
    enabledBox.checked = st.enabled !== false;

    // лог
    const log = $('log');
    const list = (events || []).slice(-40).reverse();
    log.innerHTML = list.length
      ? list
          .map(
            (e) =>
              '<div><span class="t">' +
              new Date(e.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
              '</span>' +
              escapeHtml(e.text) +
              '</div>',
          )
          .join('')
      : '<div>Пока пусто. Открой Spotify, задай канал — зрители пишут !sr в чат Twitch.</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function refresh() {
    chrome.storage.local.get(['tq_status', 'tq_events'], (r) => render(r.tq_status, r.tq_events));
  }

  $('save').addEventListener('click', () => {
    chrome.storage.local.set({ tq_channel: channelInput.value.trim().toLowerCase() });
  });
  channelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save').click();
  });
  enabledBox.addEventListener('change', () => {
    chrome.storage.local.set({ tq_enabled: enabledBox.checked });
  });

  chrome.storage.onChanged.addListener(refresh);
  refresh();
  setInterval(refresh, 1000);
})();
