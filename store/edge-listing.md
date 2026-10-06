# Microsoft Edge Add-ons listing

The same code base and nearly the same texts as the Chrome Web Store
([listing.md](listing.md)). This file covers only what is different for the
[Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).

## Package

```bash
npm ci
npm run zip:edge        # → .output/*-edge.zip
```

- WXT builds the Edge package from the same sources. The manifest is identical apart from what WXT adjusts for the target.
- Edge supports everything the extension uses: MV3 service worker, `chrome.debugger`
  (`Page.printToPDF`), `chrome.offscreen` (Edge 109+), `chrome.permissions` optional host
  permissions, `chrome.storage.managed`, commands and context menus. `minimum_chrome_version: 120`
  also applies to Edge, because Edge uses Chromium version numbers.
- Test the Edge build before you submit it (`npm run dev:edge`, or load `.output/edge-mv3` unpacked at
  `edge://extensions` with *Developer mode* on). Run the manual checklist in
  [docs/TESTING.md](../docs/TESTING.md), at least the *Smoke* section.

## Properties

| Field | Value |
|---|---|
| Category | Productivity |
| Privacy policy required | Yes. The extension handles website content and the user's display name locally. Use the same URL as for Chrome ([PRIVACY.md](../PRIVACY.md)). |
| Website | Repository URL |
| Support contact | Repository issues URL or `<your-email>` |
| Mature content | No |

## Store listing (English)

| Field | Value / source |
|---|---|
| Display name | `Fast PDF Export for Confluence` (comes from the manifest and must match) |
| Short description | The manifest description (115 characters, below Edge's limit) |
| Description | The *Detailed description* block in [listing.md](listing.md). Edge requires at least 250 characters. The Chrome text qualifies. In the *Good to know* bullet, change "Chrome briefly shows a bar" to "Edge briefly shows a bar". |
| Store logo | `store/edge-logo-300x300.png` (1:1, 300×300, transparent background) |
| Small promotional tile | `store/promo-small-440x280.png` |
| Large promotional tile | `store/marquee-1400x560.png` |
| Screenshots | The same 1280×800 screenshots as Chrome, taken in Edge if possible |
| Search terms | `Confluence`, `PDF`, `export`, `documentation`, `wiki`, `print` (Edge allows up to 7 terms, 30 characters each and 21 words in total) |

## Notes for certification

Paste into *Notes for certification*:

```
The extension exports Confluence pages to PDF locally in the browser. To test: open any Confluence Cloud page you can access (a free Atlassian Cloud site works), click the toolbar icon, choose "This page" and click Export. Edge asks once for access to that site. The PDF is saved to Downloads.

The "debugger" permission is used only to call Page.printToPDF on a tab the extension opened itself; Edge shows the "started debugging this browser" bar while the PDF is printed. No host permissions are granted at install time: access is requested at runtime for one Confluence site at a time (optional_host_permissions), because Confluence can run on any domain (Atlassian Cloud, custom domains, self-hosted Data Center). No remote code, no analytics, no network requests other than read-only GETs to the Confluence site being exported.
```

## Edge-specific behavior to be aware of

- The debugging bar in Edge says *"Fast PDF Export for Confluence" started debugging this browser*,
  the same as in Chrome. Clicking **Cancel** on it stops the current print.
- Edge's built-in "Ask where to save each file" setting is respected, the same as in Chrome.
- Settings sync through the user's Microsoft account if Edge sync is on (`chrome.storage.sync`
  is backed by Edge sync).
- Enterprise deployment through Edge policies is covered in [docs/ENTERPRISE.md](../docs/ENTERPRISE.md#microsoft-edge).
- The Edge Add-ons extension ID is different from the Chrome Web Store ID. Use the right ID in policies.
