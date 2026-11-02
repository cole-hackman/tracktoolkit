import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { entryKey, parseSetlist, rankCandidates, searchQuery, stripLabel, titleFromSourceUrl } from "../src/lib/setlist";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

/**
 * The fixtures are what a user gets by selecting a 1001Tracklists tracklist in
 * the browser and copying it (captured 2026-11-02; the IDers' names replaced
 * with "ider"). Server-side fetching of those pages is captcha-blocked, which
 * is why the feature parses pasted text at all.
 */
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", "setlists", name), "utf8");

test.describe("parseSetlist — Peggy Gou & Four Tet @ Head Trip", () => {
  const { entries, suggestions } = parseSetlist(fixture("head-trip-2026-10-10.txt"));

  test("keeps every played row, in order, numbered 1..n", () => {
    expect(entries).toHaveLength(27);
    expect(entries.map((e) => e.position)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    expect(entries[0].label).toBe("Four Tet - ID");
    expect(entries[26].label).toBe("Peggy Gou - (It Goes Like) Nanana");
  });

  test("marks the five unidentified rows and never makes them searchable tracks", () => {
    const unidentified = entries.filter((e) => e.kind === "unidentified");
    expect(unidentified.map((e) => e.position)).toEqual([1, 2, 6, 8, 26]);
    expect(unidentified.map((e) => e.label)).toEqual(["Four Tet - ID", "ID - ID", "ID - ID", "ID - ID", "ID - ID"]);
    expect(entries.filter((e) => e.kind === "track")).toHaveLength(22);
  });

  test("reports the community suggestion under an ID instead of adding it", () => {
    expect(suggestions).toEqual(["Chris Lake - Attention"]);
    expect(entries.some((e) => e.label === "Chris Lake - Attention")).toBe(false);
  });

  test("keeps 'w/' rows in place, flagged as played over the previous one", () => {
    const withPrevious = entries.filter((e) => e.withPrevious).map((e) => [e.position, e.label]);
    expect(withPrevious).toEqual([
      [11, "Headie One - Both (Acappella)"],
      [12, "Megan Thee Stallion - Body (Acappella)"],
    ]);
  });

  test("strips the record label glued onto the title, and keeps all-caps titles", () => {
    const label = (n: number) => entries[n - 1].label;
    expect(label(4)).toBe("CASSIMM - Love Desire");
    expect(label(9)).toBe("Joy Orbison - FELTTTT");
    expect(label(12)).toBe("Megan Thee Stallion - Body (Acappella)");
    expect(label(21)).toBe("Chris Lake & Sammy Virji & RoRo - 925 (Four Tet Remix)");
    expect(label(23)).toBe("Four Tet - Baby (Tony Romera Remix)");
    // Ambiguous: "NRG" reads as part of the label. It is kept for ranking.
    expect(label(22)).toBe("Jake Shore & Henry Fong - Feel My");
    expect(entries[21].dropped).toEqual(["NRG", "BANZAI", "RECS"]);
  });

  test("drops an unknown remix from the search query", () => {
    expect(searchQuery(entries[15])).toBe("Armand van Helden The Funk Phenomena");
    expect(searchQuery(entries[3])).toBe("CASSIMM Love Desire");
  });
});

test.describe("parseSetlist — deadmau5 @ Red Rocks, Night 2", () => {
  const { entries, suggestions } = parseSetlist(fixture("deadmau5-red-rocks-2026-10-31.txt"));

  test("keeps all 43 rows, none unidentified, no suggestions", () => {
    expect(entries).toHaveLength(43);
    expect(entries.every((e) => e.kind === "track")).toBe(true);
    expect(suggestions).toEqual([]);
  });

  test("ignores comment lines and trailing notes", () => {
    expect(entries.some((e) => /VOWWS/.test(e.label))).toBe(false);
    expect(entries[37].label).toBe("deadmau5 - Take Care Of The Proper Paperwork");
  });

  test("handles a title that is all capitals plus a label", () => {
    expect(entries[8].label).toBe("Vion Konger - BODY");
    expect(entries[8].dropped).toEqual(["SMASH", "THE", "HOUSE"]);
  });

  test("acappella and stem rows stay distinct from the full track", () => {
    const ghosts = entries.filter((e) => e.label === "deadmau5 ft. Rob Swire - Ghosts 'n' Stuff");
    expect(ghosts.map((e) => e.position)).toEqual([18]);
    const rydly = entries.filter((e) => /Rydly/.test(e.label)).map((e) => e.label);
    expect(rydly).toEqual(["deadmau5 - Rydly (Lead Stem)", "deadmau5 - Rydly"]);
    const keys = entries.map(entryKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

test.describe("parseSetlist — other input shapes", () => {
  test("a plain numbered list with labels in brackets", () => {
    const { entries } = parseSetlist("01. Calyx - House Breaker [CRITICAL]\n02. [05:30] w/ Rova - Eyes On Me\n666 - Alarma");
    expect(entries.map((e) => [e.label, e.withPrevious])).toEqual([
      ["Calyx - House Breaker", false],
      ["Rova - Eyes On Me", true],
      ["666 - Alarma", false],
    ]);
  });

  test("SoundCloud URLs become url entries", () => {
    const { entries } = parseSetlist("https://soundcloud.com/deadmau5/strobe\nhttps://example.com/a - b");
    expect(entries.map((e) => e.kind)).toEqual(["url", "track"]);
    expect(entries[0].label).toBe("https://soundcloud.com/deadmau5/strobe");
  });

  test("stripLabel keeps a one-word all-caps title", () => {
    expect(stripLabel("FELTTTT")).toEqual({ title: "FELTTTT", dropped: [] });
    expect(stripLabel("Bangarang VIP")).toEqual({ title: "Bangarang VIP", dropped: [] });
  });

  test("titleFromSourceUrl reads the slug and never accepts another host", () => {
    expect(titleFromSourceUrl("https://www.1001tracklists.com/tracklist/23pzf2u1/peggy-gou-four-tet-head-trip-united-states-2026-10-10.html"))
      .toBe("Peggy Gou Four Tet Head Trip United States 2026-10-10");
    expect(titleFromSourceUrl("https://evil.example/tracklist/x/a-b.html")).toBeNull();
    expect(titleFromSourceUrl("not a url")).toBeNull();
  });
});

test.describe("rankCandidates", () => {
  const entry = (line: string) => parseSetlist(line).entries[0];
  const sc = (id: number, title: string, username: string, access = "playable") => ({ id, title, user: { username }, access });

  test("picks the confident, playable match and labels it as matched", () => {
    const { pick, ranked } = rankCandidates(entry("deadmau5 - Strobe ULTRA/MAU5TRAP"), [
      sc(4, "Strobe (Dimension Remix)", "deadmau5"),
      sc(5, "Strobe", "deadmau5"),
    ]);
    expect(pick?.track.id).toBe(5);
    expect(pick?.label).toBe("deadmau5 - Strobe");
    expect(ranked.map((r) => [r.track.id, r.fit])).toEqual([[5, "confident"], [4, "possible"]]);
  });

  test("counts an uploader account named after the artist", () => {
    const { pick } = rankCandidates(entry("CASSIMM - Love Desire  GOLDEN"), [sc(1619224347, "Love Desire", "cassimmofficial")]);
    expect(pick?.track.id).toBe(1619224347);
  });

  test("puts dropped label words back when the title needs them", () => {
    const { pick } = rankCandidates(entry("Jake Shore & Henry Fong - Feel My NRG BANZAI RECS"), [
      sc(3, "Jake Shore & Henry Fong - Feel My NRG", "banzai"),
    ]);
    expect(pick?.label).toBe("Jake Shore & Henry Fong - Feel My NRG");
  });

  test("never picks a preview, another version, or an unknown remix", () => {
    expect(rankCandidates(entry("Calyx - House Breaker"), [sc(6, "House Breaker", "calyx", "preview")]).pick).toBeNull();
    expect(rankCandidates(entry("deadmau5 - Strobe"), [sc(4, "Strobe (Dimension Remix)", "deadmau5")]).pick).toBeNull();
    const idRemix = rankCandidates(entry("Armand van Helden - The Funk Phenomena (ID Remix)"), [
      sc(8, "The Funk Phenomena", "armandvanhelden"),
    ]);
    expect(idRemix.pick).toBeNull();
    expect(idRemix.ranked[0].fit).toBe("possible");
  });

  test("a different record is weak", () => {
    expect(rankCandidates(entry("Rova - Eyes On Me"), [sc(9, "Something Else", "rova")]).ranked[0].fit).toBe("weak");
  });
});
