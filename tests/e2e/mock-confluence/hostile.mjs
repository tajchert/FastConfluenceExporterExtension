/**
 * Known HTML-injection vectors for the sanitizer, shared by the unit test (happy-dom) and the
 * E2E mock page "Hostile Page" (real Chromium). `beacon` is a JavaScript statement without spaces
 * or double quotes; it only runs if a vector got through (the E2E variant requests
 * `/wiki/__pwned?v=N` from the mock, which records it).
 *
 * @param {(n: number) => string} beacon
 * @returns {string}
 */
export function hostileHtml(beacon) {
  const b = (n) => beacon(n);
  return [
    `<p>Hostile page: every vector below must stay inert.</p>`,
    `<p><img src="x" onerror="${b(1)}" alt="img onerror"></p>`,
    `<svg onload="${b(2)}"><circle r="1"></circle></svg>`,
    `<svg><a xlink:href="javascript:${b(3)}"><text x="10" y="20">svg link</text></a></svg>`,
    `<math><mtext><table><mglyph><style><img src=x onerror=${b(4)}></style></mglyph></table></mtext></math>`,
    `<noscript><p title="</noscript><img src=x onerror=${b(5)}>"></p></noscript>`,
    `<meta http-equiv="refresh" content="0;url=javascript:${b(6)}">`,
    `<base href="//evil.example/">`,
    `<iframe srcdoc="<script>${b(7)}</script>"></iframe>`,
    `<object data="javascript:${b(8)}"></object>`,
    `<form><button formaction="javascript:${b(9)}">go</button></form>`,
    `<p><a href="jav&#x09;ascript:${b(10)}">tab link</a></p>`,
    `<template><img src=x onerror="${b(11)}"></template>`,
    `<div style="background:url(javascript:${b(12)})">styled</div>`,
    `<details open ontoggle="${b(13)}"><summary>details</summary>x</details>`,
    `<video><source onerror="${b(14)}"></video>`,
    `<input autofocus onfocus="${b(15)}">`,
    `<p><a href="javascript:${b(16)}">js link</a></p>`,
    `<script>${b(17)}</script>`,
    `<p><a href="data:text/html,<script>${b(18)}</script>">data link</a></p>`,
    `<p>End of the hostile page.</p>`,
  ].join('\n');
}
