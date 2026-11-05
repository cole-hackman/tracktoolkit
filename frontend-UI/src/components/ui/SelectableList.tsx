import { cn } from "@/lib/utils";

interface SelectableListProps {
  children: React.ReactNode;
  /** Names the list ("Playlists") when nothing visible labels it. */
  label?: string;
  className?: string;
}

/**
 * The `<ul>` a stack of `SelectableRow`s belongs in, so a screen reader
 * announces "list, 40 items" instead of reading forty unrelated groups.
 *
 * `role="list"` is explicit because `list-style: none` (which Tailwind's
 * preflight applies to every `ul`) makes WebKit drop the list semantics.
 */
export function SelectableList({ children, label, className }: SelectableListProps) {
  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- see the note above: WebKit drops it
    <ul role="list" aria-label={label} className={cn("grid gap-2", className)}>
      {children}
    </ul>
  );
}
