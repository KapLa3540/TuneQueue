/* TuneQueue popup: status, enable switch, Twitch authorize. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const enabledBox = $('enabled');

  let device = null;
  let configSet = null; // null = unknown (no fresh content script yet)
  let localError = '';
  let loginRequestAt = 0;
  let openedForCode = ''; // activation tab opened for this user_code

  const STATUS_TEXT = {
    joined: ['ok', 'bot in chat'],
    joining: ['warn', 'connecting to chat…'],
    failed: ['bad', 'channel not found?'],
    none: ['warn', 'not connected'],
  };

  function render(status) {
    const chips = $('chips');
    const st = status || {};
    let html = '';
    if (st.loggedIn && st.nick) {
      const [cls, text] = STATUS_TEXT[st.joinState || 'none'] || STATUS_TEXT.none;
      html += '<span class="chip ' + cls + '">' + text + ' #' + esc(st.nick) + '</span>';
    } else {
      html += '<span class="chip warn">Twitch not connected</span>';
    }
    if (st.busy) html += '<span class="chip warn">adding track…</span>';
    chips.innerHTML = html;

    enabledBox.checked = st.enabled !== false;
    renderTwitch(st);
  }

  function renderTwitch(st) {
    const logged = Boolean(st.loggedIn && st.nick);
    const waiting = device && device.status === 'waiting';
    $('twitch-disconnected').hidden = logged || waiting;
    $('twitch-waiting').hidden = !waiting;
    $('twitch-connected').hidden = !logged;
    if (logged) $('twitch-nick').textContent = '@' + st.nick;
    if (waiting) $('device-code').textContent = device.user_code || '…';

    // the request went out but nothing came back for 5s → stale Spotify tab
    if (
      !logged &&
      !waiting &&
      loginRequestAt &&
      Date.now() - loginRequestAt > 5000 &&
      (!device || !device.status || device.status !== 'error')
    ) {
      localError =
        'The Spotify tab did not respond. Reload the open.spotify.com tab (and the extension), then try again.';
    }

    const errBox = $('twitch-error');
    const text = localError || (!logged && !waiting && device && device.status === 'error' ? device.error || 'See the browser console' : '');
    if (!logged && text) {
      errBox.hidden = false;
      errBox.textContent = text;
    } else {
      errBox.hidden = true;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function refresh() {
    chrome.storage.local.get(['tq_status', 'tq_device', 'tq_config'], (r) => {
      const stDev = r.tq_device || null;
      // keep the locally-armed waiting panel until storage responds
      if (stDev) device = stDev;
      else if (!loginRequestAt) device = null;
      configSet = r.tq_config && typeof r.tq_config.clientIdSet === 'boolean' ? r.tq_config.clientIdSet : null;
      if (device && device.status === 'waiting' && loginRequestAt && Date.now() - loginRequestAt > 4000) {
        loginRequestAt = 0; // content script responded — stop the stale timer
      }
      if (device && (device.status === 'error' || device.status === 'done')) loginRequestAt = 0;
      render(r.tq_status || {});

      // Twitch replied — open the activation page (it already contains the code)
      const uri = device && device.status === 'waiting' && (device.verification_uri_complete || device.verification_uri);
      if (uri && openedForCode !== device.user_code) {
        openedForCode = device.user_code;
        chrome.tabs.create({ url: uri });
      }
    });
  }

  enabledBox.addEventListener('change', () => {
    chrome.storage.local.set({ tq_enabled: enabledBox.checked });
  });

  $('twitch-login').addEventListener('click', () => {
    localError = '';
    device = null;
    if (configSet === false) {
      localError = 'Set the Twitch app Client ID in extension/config.js, then reload the extension.';
      renderTwitch({ loggedIn: false });
      return;
    }
    loginRequestAt = Date.now();
    device = { status: 'waiting', user_code: '' };
    openedForCode = '';
    renderTwitch({ loggedIn: false });
    chrome.storage.local.set({ tq_device: null, tq_twitch_login_request: Date.now() });
  });

  $('open-activate').addEventListener('click', () => {
    const url = (device && (device.verification_uri_complete || device.verification_uri)) || 'https://www.twitch.tv/activate';
    chrome.tabs.create({ url });
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
