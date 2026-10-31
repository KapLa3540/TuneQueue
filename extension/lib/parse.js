/* TuneQueue: чистые функции разбора (работают и в расширении, и в тестах). */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TQParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const URL_RE = /https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/i;
  const URI_RE = /spotify:track:([A-Za-z0-9]{22})/i;

  /** Найти ссылку/URI на трек ВНУТРИ любого текста (markdown [x](x), двоеточия, слова). */
  function extractSpotifyTrack(text) {
    const u = String(text || '').match(URL_RE);
    if (u) return { trackId: u[1], url: 'https://open.spotify.com/track/' + u[1] };
    const uri = String(text || '').match(URI_RE);
    if (uri) return { trackId: uri[1], url: 'https://open.spotify.com/track/' + uri[1] };
    return null;
  }

  const KNOWN = new Set(['sr', 'play', 'songrequest']);

  /**
   * Разобрать команду из сообщения чата.
   * Терпим к : в начале, markdown-ссылкам и т.п.
   * Возвращает { name, raw, rest } | null.
   */
  function normalizeCommand(text) {
    const t = String(text || '').trim().replace(/^[:\s»>|-]+/, '');
    const m = t.match(/^!(\S+)/);
    if (!m) return null;
    const name = m[1].toLowerCase().replace(/[^a-z]/g, '');
    return { name: name, raw: m[1], rest: t.slice(m[0].length).trim(), known: KNOWN.has(name) };
  }

  /** Тексты пункта меню «Добавить в очередь» на разных языках. */
  const QUEUE_MENU_TEXTS = [
    'add to queue',
    'add song to queue',
    'добавить в очередь',
    'добавить песню в очередь',
    'hinzufügen zur warteschlange',
    'in die warteschlange',
    'añadir a la cola',
    'ajouter à la file',
    'adicionar à fila',
    'キューに追加',
    '加入播放队列',
  ];

  /** Похож ли текст пункта меню на «Добавить в очередь». */
  function matchAddToQueue(label) {
    const s = String(label || '').trim().toLowerCase();
    if (!s || s.length > 60) return false;
    return QUEUE_MENU_TEXTS.some(function (t) {
      return s === t || s.startsWith(t + ' ');
    });
  }

  /** Кулдаун: true если можно, false если рано. */
  function cooldownAllows(map, key, now, ms) {
    if (map.has(key)) {
      const prev = map.get(key);
      if (now - prev < ms) return false;
    }
    map.set(key, now);
    return true;
  }

  function isSpotifyShortLink(u) {
    try {
      const url = new URL(String(u).startsWith('http') ? String(u) : 'https://' + u);
      const h = url.hostname.toLowerCase();
      return h === 'spotify.link' || h === 'www.spotify.link' || h === 'spotify.app.link';
    } catch (e) {
      return false;
    }
  }

  return {
    extractSpotifyTrack: extractSpotifyTrack,
    normalizeCommand: normalizeCommand,
    matchAddToQueue: matchAddToQueue,
    cooldownAllows: cooldownAllows,
    isSpotifyShortLink: isSpotifyShortLink,
    QUEUE_MENU_TEXTS: QUEUE_MENU_TEXTS,
  };
});
