# Privacy Policy: Fast PDF Export for Confluence

_Last updated: 6 October 2026_

This policy covers the browser extension "Fast PDF Export for Confluence" (the "extension") for
Google Chrome, Microsoft Edge and other Chromium-based browsers.

**Short version: the extension does not collect, transmit, sell or share any of your data. Everything happens on your own device.**

## 1. What the extension does with data

To create a PDF, the extension reads content from the Confluence site you are exporting from and
processes it **locally in your browser**:

| Data | How it is used | Where it goes |
|---|---|---|
| Confluence page content (text, HTML, images, titles, breadcrumbs, last-updated dates, author names) | Read from the Confluence site you are viewing to build the PDF. | Kept in browser memory while the export runs, then written to the PDF in your downloads folder. It is discarded once the export finishes or is cancelled. |
| Address (URL) of the current tab | Read when you click the extension icon, press its keyboard shortcut or use its context menu, so the extension can tell which page, folder or space to export. | Stays on your device. |
| Your Confluence display name | Printed on the PDF cover page ("Exported by") and in the PDF's Author field. | Stays on your device, inside the PDF you create. |
| Export progress (page titles, URLs, error messages for the running export) | Shows progress and the error summary. | Stored in the browser's session storage, which is held in memory and cleared when the browser closes. |
| Your settings (default paper size, margins, toggles, concurrency and similar) | Remembers your preferences. | Stored in `chrome.storage.sync`. If you have turned on browser sync, your browser syncs these settings between your own devices through your Google (or Microsoft) account, under that provider's privacy policy. The developer never receives them. Optional custom CSS is stored only on this device (`chrome.storage.local`). |
| Sites you allowed | Chrome itself records which Confluence sites you granted the extension access to. | Managed by your browser. You can revoke access at any time. |
| Administrator policy | If your organization manages your browser, the extension reads policy values your administrator set (for example, blocked spaces or a page limit). | Read-only. Stays on your device. |

## 2. Network access

- The extension sends network requests **only to the Confluence site you are exporting from**,
  and only to read content (HTTP `GET`). It never creates, edits or deletes anything in Confluence.
- Those requests use your existing browser session with that site, exactly as when you browse
  it yourself. The extension **never reads, stores or sends your cookies, passwords or tokens**.
- The extension makes **no other network requests**: no analytics, telemetry, crash reporting,
  advertising, fonts, CDNs or remote code. All of its code ships inside the extension package.
- When you use the optional **Live render** feature, the extension opens the Confluence page itself
  in a background tab, so that page loads the same way as when you open it yourself. This
  includes any third-party apps your Confluence administrator installed. Those requests are made
  by Confluence's own page, not by the extension.

## 3. What the extension does NOT do

- It does not collect personal information or browsing history.
- It does not send any data to the developer or to any third party.
- It does not sell, rent or share data, and it does not use data for advertising, credit scoring
  or any purpose other than creating the PDF you asked for.
- It does not run on any website until you grant access to that site, and it only acts there
  when you start an export.

## 4. Permissions

The extension asks for browser permissions only to provide its single purpose: exporting
Confluence pages to PDF. The [README](README.md#permissions) explains each permission.

## 5. Data retention and deletion

- Page content and PDF data exist only in memory while an export runs.
- The PDFs and ZIP files you create are ordinary files in your downloads folder. You control them.
- To delete all data the extension keeps, remove the extension. This deletes its settings and
  session data. You can also reset the settings on the options page, and revoke site access
  at `chrome://extensions` → *Details* → *Site access*.

## 6. Children

The extension is a productivity tool for Confluence users and is not directed at children.

## 7. Changes to this policy

If this policy changes, the new version will be published at the same address with a new
"Last updated" date. Any change that introduced data collection would require your consent first.

## 8. Contact

Questions about privacy: **<your-email>**

"Confluence" is a trademark of Atlassian. This extension is not affiliated with or endorsed by Atlassian.
