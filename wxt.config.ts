import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

// https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: ({ mode }) => ({
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: '120',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    permissions: [
      'activeTab',
      'scripting',
      'storage',
      'downloads',
      'debugger',
      'notifications',
      'contextMenus',
      'offscreen',
    ],
    // Generic: no Confluence site is hard-coded. Access to a site is requested at runtime,
    // per origin, the first time the user exports from it (or added on the options page).
    // The e2e build (`wxt build --mode e2e` → .output/chrome-mv3-e2e) pre-grants the local mock
    // Confluence so tests need not click the permission prompt. Production omits the key entirely.
    ...(mode === 'e2e' ? { host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'] } : {}),
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    },
    commands: {
      'export-current-page': {
        suggested_key: { default: 'Alt+Shift+P' },
        description: '__MSG_commandExportCurrent__',
      },
    },
    storage: {
      managed_schema: 'managed_schema.json',
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  }),
});
