/* TuneQueue popup: status, enable switch, Twitch authorize. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const enabledBox = $('enabled');

  let device = null;

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
    if (!logged && !waiting && device && device.status === 'error') {
      errBox.hidden = false;
      errBox.textContent = device.error || 'See the browser console';
    } else {
      errBox.hidden = true;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function refresh() {
    chrome.storage.local.get(['tq_status', 'tq_device'], (r) => {
      device = r.tq_device || null;
      render(r.tq_status || {});
    });
  }

  enabledBox.addEventListener('change', () => {
    chrome.storage.local.set({ tq_enabled: enabledBox.checked });
  });

  $('twitch-login').addEventListener('click', () => {
    device = { status: 'waiting', user_code: '' };
    renderTwitch({ loggedIn: false });
    chrome.storage.local.set({ tq_twitch_login_request: Date.now() });
    // open the activation page as soon as Twitch returns the URL
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      chrome.storage.local.get('tq_device', (r) => {
        const d = r.tq_device;
        if (d && d.status === 'waiting' && d.verification_uri_complete) {
          clearInterval(t);
          chrome.tabs.create({ url: d.verification_uri_complete });
        } else if (tries > 20 || (d && d.status === 'error')) {
          clearInterval(t);
        }
      });
    }, 500);
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
