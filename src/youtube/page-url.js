import { canonicalMediaPage } from '../media/page-url.js';

/** Returns the single canonical public watch URL, or null for every other input. */
export function canonicalYouTubePageUrl(value) {
  const page = canonicalMediaPage(value);
  return page?.platform === 'youtube' ? page.canonicalUrl : null;
}
