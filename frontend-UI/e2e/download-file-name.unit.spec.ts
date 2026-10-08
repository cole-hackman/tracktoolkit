import { test, expect } from "@playwright/test";
import { buildFileName, extensionFromContentType, extensionFromDisposition, safeFileName, sniffAudioExtension } from "../src/lib/download-file-name";

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "viewport-independent unit tests");
});

const bytes = (s: string) => new TextEncoder().encode(s);

test("safeFileName strips what no filesystem accepts and keeps what DJs read", () => {
  expect(safeFileName("Nick Sprag - White Noise (Remix)")).toBe("Nick Sprag - White Noise (Remix)");
  expect(safeFileName('A/B\\C:D*E?F"G<H>I|J')).toBe("A-B-C-D-E-F-G-H-I-J");
  expect(safeFileName("  spaced   out  ")).toBe("spaced out");
  expect(safeFileName("ends with dots...")).toBe("ends with dots");
  expect(safeFileName("tab\there\u0000nul")).toBe("tab here nul");
  expect(safeFileName("")).toBe("");
  // Long titles are cut, never split mid-word when a space is near.
  expect(safeFileName("x".repeat(300)).length).toBeLessThanOrEqual(150);
});

test("sniffAudioExtension reads the container, not the label", () => {
  expect(sniffAudioExtension(bytes("RIFF\u0000\u0000\u0000\u0000WAVEfmt "))).toBe("wav");
  expect(sniffAudioExtension(bytes("ID3\u0004\u0000"))).toBe("mp3");
  expect(sniffAudioExtension(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
  expect(sniffAudioExtension(bytes("fLaC\u0000"))).toBe("flac");
  expect(sniffAudioExtension(bytes("FORM\u0000\u0000\u0000\u0000AIFF"))).toBe("aiff");
  expect(sniffAudioExtension(bytes("FORM\u0000\u0000\u0000\u0000AIFC"))).toBe("aiff");
  expect(sniffAudioExtension(bytes("\u0000\u0000\u0000\u0018ftypM4A "))).toBe("m4a");
  expect(sniffAudioExtension(bytes("OggS"))).toBe("ogg");
  expect(sniffAudioExtension(bytes("<html>"))).toBeNull();
  expect(sniffAudioExtension(new Uint8Array(0))).toBeNull();
});

test("the extension comes from the bytes first, then the headers, and the name is Artist - Title", () => {
  expect(extensionFromContentType("audio/wav")).toBe("wav");
  expect(extensionFromContentType("audio/x-wav; charset=binary")).toBe("wav");
  expect(extensionFromContentType("audio/mpeg")).toBe("mp3");
  expect(extensionFromContentType("audio/x-aiff")).toBe("aiff");
  expect(extensionFromContentType("audio/flac")).toBe("flac");
  expect(extensionFromContentType("audio/mp4")).toBe("m4a");
  expect(extensionFromContentType("application/octet-stream")).toBeNull();
  expect(extensionFromContentType(null)).toBeNull();
  expect(extensionFromDisposition('attachment; filename="drakeMASTERED_.wav"')).toBe("wav");
  expect(extensionFromDisposition("attachment; filename*=UTF-8''final%20styler%20mashup.WAV")).toBe("wav");
  expect(extensionFromDisposition("inline")).toBeNull();
  expect(extensionFromDisposition(null)).toBeNull();

  const item = { artist: "Nick Sprag", title: "Disclosure, AlunaGeorge - White Noise (Nick Sprag Remix)" };
  // Bytes win: the CDN says octet-stream and the artist uploaded a wav.
  expect(buildFileName(item, { head: bytes("RIFF....WAVEfmt "), contentType: "application/octet-stream", disposition: null })).toBe(
    "Nick Sprag - Disclosure, AlunaGeorge - White Noise (Nick Sprag Remix).wav",
  );
  // No recognisable bytes: the headers decide, disposition before type.
  expect(buildFileName(item, { head: bytes("????"), contentType: "audio/mpeg", disposition: 'attachment; filename="x.aiff"' })).toMatch(/\.aiff$/);
  expect(buildFileName(item, { head: bytes("????"), contentType: "audio/mpeg", disposition: null })).toMatch(/\.mp3$/);
  // Nothing at all: still a usable name, mp3 as the last resort.
  expect(buildFileName({ artist: "", title: "Untitled" }, { head: new Uint8Array(0), contentType: null, disposition: null })).toBe("Untitled.mp3");
  // A title that already starts with the artist is not doubled.
  expect(buildFileName({ artist: "KETTAMA", title: "KETTAMA - Alcatraz" }, { head: bytes("ID3"), contentType: null, disposition: null })).toBe("KETTAMA - Alcatraz.mp3");
});
