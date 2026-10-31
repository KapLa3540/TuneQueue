/* TuneQueue popup: status, enable switch, Twitch authorize. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const enabledBox = $('enabled');

  let device = null;
  let localError = '';
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

    const errBox = $('twitch-error');
    const text =
      localError || (!logged && !waiting && device && device.status === 'error' ? device.error || 'See the browser console' : '');
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
    chrome.storage.local.get(['tq_status', 'tq_device'], (r) => {
      const stDev = r.tq_device || null;
      if (stDev) device = stDev;
      render(r.tq_status || {});

      // a flow started elsewhere (e.g. from a previous popup session) — offer the page
      const uri = device && device.status === 'waiting' && (device.verification_uri_complete || device.verification_uri);
      if (uri && openedForCode !== device.user_code && device.user_code) {
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
    const cid = (typeof globalThis !== 'undefined' && globalThis.TQ_TWITCH_CLIENT_ID) || '';
    if (!cid) {
      device = null;
      localError = 'Set the Twitch app Client ID in extension/config.js, then reload the extension.';
      renderTwitch({ loggedIn: false });
      return;
    }

    // show the waiting panel immediately, then ask Twitch right from the popup
    device = { status: 'waiting', user_code: '' };
    openedForCode = '';
    renderTwitch({ loggedIn: false });

    fetch('https://id.twitch.tv/oauth2/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, scopes: 'chat:read chat:edit' }).toString(),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Twitch device endpoint: HTTP ' + res.status);
        return res.json();
      })
      .then((info) => {
        const dev = {
          user_code: info.user_code,
          verification_uri: info.verification_uri,
          verification_uri_complete: info.verification_uri_complete || info.verification_uri,
          device_code: info.device_code,
          interval: info.interval || 5,
          expiresAt: Date.now() + (info.expires_in || 1800) * 1000,
          status: 'waiting',
        };
        device = dev;
        renderTwitch({ loggedIn: false });
        // save it: the content script (Spotify tab) picks it up and polls for the token
        chrome.storage.local.set({ tq_device: dev });
        // and open the activation page right away (the URL already contains the code)
        openedForCode = dev.user_code;
        chrome.tabs.create({ url: dev.verification_uri_complete || dev.verification_uri });
      })
      .catch((e) => {
        device = { status: 'error', error: String(e && e.message ? e.message : e) };
        renderTwitch({ loggedIn: false });
      });
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
