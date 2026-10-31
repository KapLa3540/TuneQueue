/* One-time setup: Twitch application Client ID.
 *
 * 1. Create a free app at https://dev.twitch.tv/console/apps
 *    (Redirect URI is not used by the device flow — any value works, e.g. https://localhost)
 * 2. Paste the Client ID below.
 * 3. Reload the extension.
 */
window.TQ_TWITCH_CLIENT_ID = 'a9zutwdcexvkeehffzgou0i3j63uel';
/* Works in content scripts (window), the popup page and any other context: */
globalThis.TQ_TWITCH_CLIENT_ID = window.TQ_TWITCH_CLIENT_ID;
