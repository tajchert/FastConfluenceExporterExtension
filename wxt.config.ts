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
    host_permissions: mode === 'e2e' ? ['http://localhost/*', 'http://127.0.0.1/*'] : [],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: '__MSG_actionTitle__',
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
