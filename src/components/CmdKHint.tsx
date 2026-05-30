function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

interface CmdKHintProps {
  /** Hide the hint (e.g. when the sidebar is open). */
  hidden?: boolean;
}

/**
 * Floating bottom-center reminder that pressing ⌘K opens the workspace
 * palette. Always visible unless the sidebar is open — the palette covers
 * it via z-index when itself opened.
 */
export function CmdKHint({ hidden }: CmdKHintProps) {
  if (hidden) return null;

  const mod = isMac() ? "⌘" : "Ctrl";
  return (
    <div id="cmdk-hint" role="status">
      <span className="cmdk-hint-text">Press</span>
      <kbd>{mod}</kbd>
      <kbd>K</kbd>
      <span className="cmdk-hint-text">to open the workspace</span>
    </div>
  );
}
