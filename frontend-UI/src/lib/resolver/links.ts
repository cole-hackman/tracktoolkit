/**
 * Links in the resolver's box: one per line, but a space-separated paste
 * counts too, since a SoundCloud URL never contains whitespace.
 */
export function parseLinks(text: string): string[] {
  return text.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}
