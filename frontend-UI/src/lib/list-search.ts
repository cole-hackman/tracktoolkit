/**
 * Client-side search over a list the page already holds in full.
 *
 * Every list a user picks from (playlists, likes, followings, reposts, a
 * playlist's tracks) is filtered here rather than by hand on each page, so
 * the rules are the same everywhere:
 *
 * - case- and accent-insensitive ("Beyonce" finds "Beyoncé");
 * - every word typed must appear somewhere in the item's text, in any order
 *   ("lane 8 remix" finds "Remix — Lane 8");
 * - an empty query matches everything.
 *
 * It filters whatever array it is given. Pages pass the whole collection
 * (the `/api/likes`, `/api/playlists`, `/api/followings` responses are
 * complete lists, crawled server-side), never only the rows a virtualizer
 * has rendered. Where a list is still arriving page by page, the page says
 * so next to the count ("more still loading") instead of pretending the
 * search covered everything.
 */

import { useMemo } from "react";

/** Lower-cased, accents stripped, punctuation collapsed to spaces. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

export function matchesSearch(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const normalized = normalizeSearchText(haystack);
  return terms.every((term) => normalized.includes(term));
}

export function filterBySearch<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return items as T[];
  return items.filter((item) => matchesSearch(getText(item), terms));
}

/**
 * `filterBySearch` memoised on the inputs. `getText` should be stable (a
 * module-level function or a `useCallback`) or the memo re-runs every render,
 * which is correct but wasted work on a 5,000-row list.
 */
export function useListSearch<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): { results: T[]; isFiltered: boolean } {
  const results = useMemo(() => filterBySearch(items, query, getText), [items, query, getText]);
  return { results, isFiltered: searchTerms(query).length > 0 };
}
