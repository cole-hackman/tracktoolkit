/**
 * Retired page paths -> the page that replaced them, for `mountStaticSite`'s
 * `aliases`. A 301 (not a client-side redirect), so search engines and old
 * bookmarks converge on the new URL. Keys have no trailing slash; the static
 * site normalizes one away before looking a path up.
 */
export const RETIRED_PATH_ALIASES = Object.freeze({
  '/sc-toolkit': '/faq/#rebrand',
  '/soundcloud-toolkit': '/faq/#rebrand',
  '/rebrand': '/faq/#rebrand',
  // Merged into the Link Resolver, which takes one link or up to 50.
  '/batch-link-resolver': '/link-resolver/',
});
