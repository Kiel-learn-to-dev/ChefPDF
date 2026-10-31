import { formatShortcut } from '../lib/shortcuts';

/** Displays a shortcut such as "Mod+K" as "Ctrl K" / "⌘K". */
export function Kbd({ keys }: { keys: string }) {
  return <kbd className="kbd">{formatShortcut(keys)}</kbd>;
}
