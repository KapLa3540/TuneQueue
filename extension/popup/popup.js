/* TuneQueue popup: настройки, вход Twitch, лог событий. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const channelInput = $('channel');
  const enabledBox = $('enabled');
  const clientInput = $('client-id');

  let device = null;

  const STATUS_TEXT = {
    joined: ['ok', 'бот в чате'],
    joining: ['warn', 'заходим в чат…'],
    failed: ['bad', 'канал не найден?'],
    none: ['warn', 'канал не задан'],
  };

  function render(status, events) {
    const chips = $('chips');
    const st = status || {};
    const [cls, text] = STATUS_TEXT[st.joinState || 'none'] || STATUS_TEXT.none;
    let html =
      '<span class="chip ' + cls + '">' + text + (st.channel ? ' #' + st.channel : '') + '</span>';
    if (st.loggedIn && st.nick) html += '<span class="chip ok">@' + esc(st.nick) + '</span>';
    else html += '<span class="chip warn">Twitch не подключён</span>';
    if (st.busy) html += '<span class="chip warn">ставим трек…</span>';
    if (st.pending) html += '<span class="chip warn">в очереди: ' + st.pending + '</span>';
    chips.innerHTML = html;

    if (document.activeElement !== channelInput) channelInput.value = st.channel || '';
    if (document.activeElement !== clientInput) clientInput.value = st.clientId || clientInput.value;
    enabledBox.checked = st.enabled !== false;

    renderTwitch(st);

    const log = $('log');
    const list = (events || []).slice(-40).reverse();
    log.innerHTML = list.length
      ? list
          .map(
            (e) =>
              '<div><span class="t">' +
              new Date(e.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
              '</span>' +
              esc(e.text) +
              '</div>',
          )
          .join('')
      : '<div>Пока пусто. Открой Spotify, задай канал — зрители пишут !sr в чат Twitch.</div>';
  }

  function renderTwitch(st) {
    const logged = Boolean(st.loggedIn && st.nick);
    const waiting = device && device.status === 'waiting';
    $('twitch-disconnected').hidden = logged || waiting;
    $('twitch-waiting').hidden = !waiting;
    $('twitch-connected').hidden = !logged;
    if (logged) $('twitch-nick').textContent = '@' + st.nick;
    if (waiting) $('device-code').textContent = device.user_code || '…';
    if (device && device.status === 'error' && !logged) {
      $('twitch-disconnected').querySelector('.hint').textContent =
        'Ошибка: ' + (device.error || 'см. лог') + ' — попробуй ещё раз';
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function refresh() {
    chrome.storage.local.get(['tq_status', 'tq_events', 'tq_device', 'tq_twitch_client_id'], (r) => {
      device = r.tq_device || null;
      const status = { ...(r.tq_status || {}), clientId: r.tq_twitch_client_id || '' };
      render(status, r.tq_events);
    });
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

  $('save-cid').addEventListener('click', () => {
    chrome.storage.local.set({ tq_twitch_client_id: clientInput.value.trim() });
  });

  $('twitch-login').addEventListener('click', () => {
    const cid = clientInput.value.trim();
    if (!cid) {
      alert('Сначала введи Client ID приложения Twitch');
      return;
    }
    chrome.storage.local.set({ tq_twitch_client_id: cid, tq_twitch_login_request: Date.now() });
  });

  $('open-activate').addEventListener('click', () => {
    if (device && device.verification_uri) {
      chrome.tabs.create({ url: device.verification_uri });
    }
  });

  $('twitch-logout').addEventListener('click', () => {
    chrome.storage.local.set({
      tq_twitch_token: null,
      tq_twitch_refresh: null,
      tq_twitch_expires: null,
      tq_twitch_nick: null,
      tq_device: null,
    });
  });

  chrome.storage.onChanged.addListener(refresh);
  refresh();
  setInterval(refresh, 1000);
})();
