import { test, expect } from "@playwright/test";
import { artistNames, indexCollection, matchTrack, normalize, parseSoundCloud, versionKey } from "../src/lib/library-match";
import type { RekordboxTrack } from "../src/lib/rekordbox-xml";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const rb = (over: Partial<RekordboxTrack>): RekordboxTrack => ({
  title: "",
  artist: "",
  mix: "",
  remixer: "",
  genre: "",
  label: "",
  durationSec: 0,
  bpm: null,
  key: null,
  ...over,
});
const sc = (id: number, title: string, username: string, durationSec?: number) => ({
  id,
  title,
  user: { username },
  duration: durationSec ? durationSec * 1000 : undefined,
});

const COLLECTION = [
  rb({ title: "Innerbloom", artist: "RÜFUS DU SOL", mix: "Machaki Remix", durationSec: 212 }),
  rb({ title: "Bound 2 Falling In Dub", artist: "Gresha", mix: "Original Mix", durationSec: 229 }),
  rb({ title: "Habits (Stay High)", artist: "Tove Lo", mix: "Extended Mix", durationSec: 300 }),
  rb({ title: "Lights Go Out", artist: "John Summit", remixer: "Dennett", durationSec: 190 }),
  rb({ title: "Intro", artist: "Someone Else", durationSec: 60 }),
  rb({ title: "So Good feat. Kuuda", artist: "CamelPhat, Josh Gigante", durationSec: 183 }),
];
const index = indexCollection(COLLECTION);

test("normalising: accents, ampersands, punctuation, artist lists", () => {
  expect(normalize("RÜFUS DU SOL")).toBe("rufus du sol");
  expect(normalize("Above & Beyond")).toBe("above and beyond");
  expect(artistNames("CamelPhat, Josh Gigante feat. Kuuda")).toEqual(["camelphat", "josh gigante", "kuuda"]);
  expect(artistNames("DENNETT x Darby")).toEqual(["dennett", "darby"]);
});

test("versions: edits of one record are one version; a remixer's name is the version", () => {
  expect(versionKey(["Extended Mix"])).toBe("");
  expect(versionKey(["Radio Edit"])).toBe("");
  expect(versionKey(["MACHAKI REMIX"])).toBe("machaki");
  expect(versionKey(["VIP"])).toBe("vip");
  expect(parseSoundCloud(sc(1, "RÜFUS DU SOL - INNERBLOOM (MACHAKI REMIX)", "MACHAKI"))).toMatchObject({
    core: "innerbloom",
    version: "machaki",
  });
});

test("owned: the same remix, whether Rekordbox keeps it in Mix, Remixer or the title", () => {
  expect(matchTrack(sc(1, "RÜFUS DU SOL - INNERBLOOM (MACHAKI REMIX)", "MACHAKI"), index).kind).toBe("owned");
  expect(matchTrack(sc(2, "John Summit - LIGHTS GO OUT (DENNETT REMIX)", "DENNETT"), index).kind).toBe("owned");
});

test("owned: an Extended or Original Mix in Rekordbox covers the plain upload", () => {
  expect(matchTrack(sc(3, "BOUND 2 FALLING IN DUB [LIMITED FREE DL]", "GRESHA"), index).kind).toBe("owned");
  expect(matchTrack(sc(4, "Tove Lo - Habits (Stay High) (Radio Edit)", "Tove Lo"), index).kind).toBe("owned");
});

test("owned: featured artists move between title and artist field", () => {
  expect(matchTrack(sc(5, "CamelPhat, Josh Gigante feat. Kuuda - So Good", "CAMELPHAT"), index).kind).toBe("owned");
});

test("other-version: same record, a different remix — and it says what you have", () => {
  const m = matchTrack(sc(6, "RÜFUS DU SOL - Innerbloom (What So Not Remix)", "What So Not"), index);
  expect(m.kind).toBe("other-version");
  expect(m.note).toBe("You have: RÜFUS DU SOL - Innerbloom (Machaki Remix)");
});

test("missing: unknown titles, and never across artists for a common title", () => {
  expect(matchTrack(sc(7, "Totally New Tune", "Somebody"), index).kind).toBe("missing");
  expect(matchTrack(sc(8, "Intro", "A Different Artist"), index).kind).toBe("missing");
});
