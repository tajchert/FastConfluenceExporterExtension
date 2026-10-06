/** User-facing error texts shared by the service worker and the worker tab. */

export const LOGIN_REQUIRED_MESSAGE = 'Please log in to Confluence in this browser, then try again.';

/** A page answered 401 mid-export and the session check confirmed the user is signed out. */
export const SESSION_EXPIRED_MESSAGE =
  'Your Confluence session has expired or you are not signed in. Sign in to Confluence in this browser and try again.';

/** An anonymous visitor (public site) asked for a page that is not public. */
export const NOT_PUBLIC_MESSAGE =
  "This page isn't public (or no longer exists). Sign in to Confluence in this browser to include it.";
