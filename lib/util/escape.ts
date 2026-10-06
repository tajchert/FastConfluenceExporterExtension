/**
 * Minimal HTML escaping for the few places where markup is built as a string. Prefer DOM APIs
 * (textContent / setAttribute) wherever possible; these exist for templates such as the Chrome
 * print footer and for tests.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for use as HTML element content. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Escapes text for use inside a double- or single-quoted HTML attribute value. */
export function escapeAttr(s: string): string {
  return String(s).replace(/[&<>"'`]/g, (c) => (c === '`' ? '&#96;' : (HTML_ESCAPES[c] ?? c)));
}
