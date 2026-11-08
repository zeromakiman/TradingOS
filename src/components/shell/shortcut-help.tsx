"use client";

import { Switch } from "../ui/choice";
import { Dialog, DialogContent } from "../ui/dialog";
import { KbdCombo } from "../ui/kbd";
import { useShellState } from "./shell-state";
import { useModifierKeyLabel } from "./use-media-query";

type ShortcutRow = { id: string; keys: string[][]; spoken: string; description: string };

/** Every shortcut (§13.4); while single-key shortcuts are off, their rows show "Off" and search keeps only Ctrl/⌘+K. */
function rows(modifier: string, singleKeys: boolean): ShortcutRow[] {
  const spokenModifier = modifier === "⌘" ? "Command" : "Control";
  const single = (row: ShortcutRow): ShortcutRow => (singleKeys ? row : { ...row, keys: [], spoken: "Off" });
  return [
    singleKeys
      ? { id: "palette", keys: [[modifier, "K"], ["/"]], spoken: `${spokenModifier} K, or slash`, description: "Search and commands" }
      : { id: "palette", keys: [[modifier, "K"]], spoken: `${spokenModifier} K`, description: "Search and commands" },
    single({ id: "plan", keys: [["P"]], spoken: "P", description: "Plan Trade" }),
    single({ id: "live", keys: [["L"]], spoken: "L", description: "Record Live Trade" }),
    single({ id: "journal", keys: [["J"]], spoken: "J", description: "Focus the journal composer (trade page)" }),
    single({ id: "help", keys: [["?"]], spoken: "Question mark", description: "Show keyboard shortcuts" }),
    { id: "submit", keys: [[modifier, "Enter"]], spoken: `${spokenModifier} Enter`, description: "Submit the journal composer or form" },
    { id: "paste", keys: [[modifier, "V"]], spoken: `${spokenModifier} V`, description: "Paste screenshots (Plan Trade, Edit Draft, trade page)" },
    { id: "viewer", keys: [["←"], ["→"], ["Esc"]], spoken: "Left arrow, right arrow, Escape", description: "Evidence viewer: previous, next, close" },
  ];
}

/**
 * Turns the single-key shortcuts (P, L, J, ?, /) on or off (WCAG 2.2 SC 2.1.4); the choice is
 * stored in cookie `tos_shortcuts`. Shown in the Keyboard shortcuts dialog; Settings → General
 * can render it too.
 */
export function SingleKeyShortcutsSwitch({ id }: { id?: string }) {
  const { singleKeyShortcuts, setSingleKeyShortcuts } = useShellState();
  const search = useModifierKeyLabel() === "⌘" ? "⌘K" : "Ctrl+K";
  return (
    <Switch
      id={id}
      label="Single-key shortcuts"
      description={`P, L, J, ? and / work anywhere outside text fields. Turn them off if you use speech input or press keys by accident; ${search} always opens search.`}
      checked={singleKeyShortcuts}
      onChange={(event) => setSingleKeyShortcuts(event.currentTarget.checked)}
    />
  );
}

/** Lists every keyboard shortcut (§13.4); opened with "?" or from the account menu. */
export function ShortcutHelp() {
  const { helpOpen, setHelpOpen, singleKeyShortcuts } = useShellState();
  const modifier = useModifierKeyLabel();
  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent title="Keyboard shortcuts" description="Single-key shortcuts are ignored while you type in a field, and you can turn them off below." size="md">
        <dl className="shortcut-list">
          {rows(modifier, singleKeyShortcuts).map((row) => (
            <div key={row.id} className="shortcut-row">
              <dt>{row.description}</dt>
              {row.keys.length === 0 ? (
                <dd className="t-caption">Off</dd>
              ) : (
                <dd>
                  <span className="sr-only">{row.spoken}</span>
                  <span aria-hidden="true" className="flex items-center gap-2">
                    {row.keys.map((combo) => (
                      <KbdCombo key={combo.join("+")} keys={combo} />
                    ))}
                  </span>
                </dd>
              )}
            </div>
          ))}
        </dl>
        <div className="mt-4 border-t border-border pt-4">
          <SingleKeyShortcutsSwitch />
        </div>
      </DialogContent>
    </Dialog>
  );
}
