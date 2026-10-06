# Enterprise deployment

How to roll out **Fast PDF Export for Confluence** to an organization: force-install it, limit it
to your Confluence sites and configure it with managed policy.

Throughout this document, `<EXTENSION_ID>` is the 32-character ID of the extension in the store
you install from. The Chrome Web Store and Edge Add-ons give it **different IDs**. You can find
the ID in the store URL or at `chrome://extensions` with Developer mode on.

---

## Google Chrome

### Option A: Google Admin console (Chrome Enterprise / Workspace)

1. Go to **Devices → Chrome → Apps & extensions → Users & browsers**.
2. Select the organizational unit (OU) or group to target.
3. Click **＋ → Add from Chrome Web Store** and enter `<EXTENSION_ID>`. For a private listing
   published only to your Workspace domain, use **Add Chrome app or extension by ID**.
4. Set **Installation policy** to **Force install** (or **Force install + pin to browser toolbar**).
5. Optional: paste a JSON configuration into **Policy for extensions** (see
   [Managed configuration](#managed-configuration) below).
6. Save. Browsers pick up the change at the next policy refresh, or right away via
   `chrome://policy` → **Reload policies**.

If you want to publish your own copy (for example with company branding in custom CSS or a
different default configuration), publish it to the Chrome Web Store with visibility **Private**.
Then only users in your Google Workspace domain can see and install it.

### Option B: `ExtensionInstallForcelist` policy (GPO, MDM, JSON)

```
<EXTENSION_ID>;https://clients2.google.com/service/update2/crx
```

- **Windows (GPO / registry):**
  `HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`, value `1` (REG_SZ) set to the line above.
- **macOS (configuration profile):** domain `com.google.Chrome`, key `ExtensionInstallForcelist`
  (array of strings).
- **Linux:** `/etc/opt/chrome/policies/managed/fast-pdf-export.json`:
  ```json
  { "ExtensionInstallForcelist": ["<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"] }
  ```

You can also use the more expressive `ExtensionSettings` policy instead:

```json
{
  "ExtensionSettings": {
    "<EXTENSION_ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://clients2.google.com/service/update2/crx",
      "toolbar_pin": "force_pinned"
    }
  }
}
```

### Limiting the extension to your Confluence sites (recommended)

The extension declares `https://*/*` and `http://*/*` as **optional** host permissions, because
Confluence can run on any domain. It has no host access until a user grants one site from the
popup or options page. Administrators can additionally restrict which sites can **ever** be
granted, with `runtime_blocked_hosts` / `runtime_allowed_hosts` in `ExtensionSettings`:

```json
{
  "ExtensionSettings": {
    "<EXTENSION_ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://clients2.google.com/service/update2/crx",
      "runtime_blocked_hosts": ["*://*"],
      "runtime_allowed_hosts": ["*://acme.atlassian.net", "*://wiki.acme.example"]
    }
  }
}
```

The extension can't access blocked hosts even if a user tries to grant them. Users still confirm
access once per allowed site, because Chrome policy can't pre-grant optional host permissions.

### Things to avoid

- **Don't** add `debugger` to `blocked_permissions`. It is a required permission, so blocking it
  stops the extension from installing or loading.
- `DeveloperToolsAvailability` = `2` (developer tools disallowed) can make `chrome.debugger`
  unavailable. The extension then falls back to the browser's print dialog ("Save as PDF").
  Exports still work but are no longer one-click. Value `1` (allowed) gives the best experience.
- Policies that block `chrome.downloads` or set `DownloadRestrictions` to block all downloads also
  block saving the PDF.

---

## Microsoft Edge

Install the extension from Edge Add-ons (or the Chrome Web Store if you allow it with
`ExtensionInstallSources`, but the Edge Add-ons listing is preferred).

`ExtensionInstallForcelist` for Edge:

```
<EDGE_EXTENSION_ID>;https://edge.microsoft.com/extensionwebstorebase/v1/crx
```

- **Windows (GPO / Intune / registry):** `HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist`,
  value `1` (REG_SZ).
- **macOS:** domain `com.microsoft.Edge`, key `ExtensionInstallForcelist`.
- **Intune:** *Devices → Configuration → Settings catalog → Microsoft Edge → Extensions →
  Control which extensions are installed silently*.

`ExtensionSettings` (including `runtime_blocked_hosts` / `runtime_allowed_hosts`) works the same way
as in Chrome, under `HKLM\Software\Policies\Microsoft\Edge\ExtensionSettings` (a JSON string).

To install the Chrome Web Store build in Edge instead, use the update URL
`https://clients2.google.com/service/update2/crx` with the Chrome Web Store ID.

---

## Managed configuration

The extension reads `chrome.storage.managed`. The schema is in
[`public/managed_schema.json`](../public/managed_schema.json). The extension validates every value
and ignores anything malformed, so a typo can't break exports.

| Key | Type | Effect |
|---|---|---|
| `blockedSpaceKeys` | array of strings | Confluence space keys that can't be exported, e.g. `["HR", "LEGAL"]`. Pages in these spaces are refused. Write the keys as they appear in Confluence URLs (`/spaces/HR/…`). |
| `disableLiveRender` | boolean | `true` turns off Live render for everyone. The option is forced off and can't be enabled. Use this if you don't want the extension to open real Confluence pages, with their third-party apps, in background tabs. |
| `maxPages` | integer ≥ 1 | Hard cap on the number of pages in one export. Larger exports are blocked, regardless of the user's warning and confirmation thresholds. |
| `defaultOptions` | object | Default export options. These values override the user's saved defaults. Any subset of the keys below is allowed. |

`defaultOptions` keys:

| Key | Type | Values |
|---|---|---|
| `paperSize` | string | `A4`, `Letter`, `Legal`, `A3` |
| `orientation` | string | `portrait`, `landscape` |
| `marginsMm` | object | `{ "top": 18, "right": 15, "bottom": 18, "left": 15 }`. Each side 0–100 mm, any subset |
| `includeCover` | boolean | Cover page |
| `includeToc` | boolean | Table of contents |
| `includePageMeta` | boolean | Header block per page (breadcrumb, last updated, link) |
| `includeComments` | boolean | Keep inline comment highlights |
| `pageNumbers` | boolean | Page numbers in the footer |
| `liveRender` | boolean | Live render by default (ignored when `disableLiveRender` is `true`) |
| `separateFiles` | boolean | One PDF per page in a ZIP |
| `includeArchived` | boolean | Include archived pages |
| `shrinkWideTables` | boolean | Shrink wide tables to fit the sheet |
| `customCss` | string | Extra print CSS, e.g. company fonts and colors (max 100,000 characters) |

### Example

```json
{
  "blockedSpaceKeys": ["HR", "LEGAL", "BOARD"],
  "disableLiveRender": false,
  "maxPages": 300,
  "defaultOptions": {
    "paperSize": "Letter",
    "includeComments": false,
    "customCss": ".cf-cover h1 { color: #0b3d91; }"
  }
}
```

### Where to put it

- **Google Admin console:** *Apps & extensions → (the extension) → Policy for extensions*. Paste
  the JSON above as is.
- **Windows registry (Chrome):**
  `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<EXTENSION_ID>\policy`.
  Create one value per key: `maxPages` (REG_DWORD), `disableLiveRender` (REG_DWORD 0/1), and
  `blockedSpaceKeys` / `defaultOptions` as subkeys or REG_SZ JSON, depending on your tooling.
- **Windows registry (Edge):**
  `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\<EDGE_EXTENSION_ID>\policy`.
- **macOS:** a configuration profile with the preference domain
  `com.google.Chrome.extensions.<EXTENSION_ID>` (Edge: `com.microsoft.Edge.extensions.<EDGE_EXTENSION_ID>`)
  containing the keys above.
- **Linux (Chrome):** `/etc/opt/chrome/policies/managed/fast-pdf-export.json`:
  ```json
  { "3rdparty": { "extensions": { "<EXTENSION_ID>": { "maxPages": 300, "blockedSpaceKeys": ["HR"] } } } }
  ```

### Verifying

1. Open `chrome://policy` (or `edge://policy`), click **Reload policies** and check that the
   extension's policy appears under *Extension policies* with status **OK**.
2. Open the extension's popup or options page and check that the defaults match your
   `defaultOptions`, and that Live render can't be turned on if `disableLiveRender` is `true`.
3. Try exporting a page from a blocked space. The export should be refused with a clear message.

---

## Security & compliance notes for reviewers

- **No backend:** no data is sent to the developer or any third party. See [PRIVACY.md](../PRIVACY.md).
- **Network:** only same-origin `GET` requests to the Confluence site being exported, with the
  user's existing session. No cookies or tokens are read.
- **No remote code:** all code is bundled. The extension pages' CSP is `script-src 'self'; object-src 'self'`.
- **`debugger`:** attached only to tabs the extension opened, only while printing, and always
  detached afterwards (also on error or cancel). Users see Chrome's "started debugging this
  browser" bar during that time.
- **Least privilege:** no install-time host permissions, no `tabs`, `cookies`, `history` or
  `webRequest` permissions.
- **Read-only:** the extension can't modify Confluence content.
- **Open source (MIT):** you can audit the code and build it yourself (`npm ci && npm run zip`).
