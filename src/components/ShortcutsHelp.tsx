/**
 * The keys dialog, as herdr-app's help mod (prefix+?): every shortcut with its current key, then
 * every registered command's own key (lib/commands.ts), filtered by typing. Opened and closed by
 * its key (Ctrl+Shift+/, ⌘/ on a Mac); Escape and the scrim close it.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./ShortcutsHelp.css";

import { commandKeys, setHelpOpen, useCommandList, useHelpOpen } from "../lib/commands.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { chordDisplayKeys, formatKeys, isMacPlatform, SHORTCUTS, shortcutDisplayKeys } from "../lib/shortcuts.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

export function ShortcutsHelp() {
  const open = useHelpOpen();
  return open ? <HelpDialog /> : null;
}

function HelpDialog() {
  const t = useT();
  const { settings } = useSettings();
  const commands = useCommandList();
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: input });
  const close = () => setHelpOpen(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const mac = isMacPlatform();
  const shortcutIds = new Set<string>(SHORTCUTS.map((shortcut) => shortcut.id));
  const rows = [
    ...SHORTCUTS.map((shortcut) => ({ id: shortcut.id, label: t(shortcut.label), keys: formatKeys(shortcutDisplayKeys(shortcut.id, settings.shortcutOverrides)) })),
    ...commands.filter((command) => !shortcutIds.has(command.id)).flatMap((command) => commandKeys(command, mac).slice(0, 1).map((chord) => ({ id: command.id, label: command.label, keys: formatKeys(chordDisplayKeys(chord)) }))),
  ].filter((row) => row.keys.length > 0);
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle === "" ? rows : rows.filter((row) => `${row.label} ${row.keys.join(" ")}`.toLocaleLowerCase().includes(needle));

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={surface} className="modal shortcuts-help" role="dialog" aria-modal="true" aria-label={t("Keyboard shortcuts")}>
        <header className="modal-header"><h2 className="modal-title">{t("Keyboard shortcuts")}</h2></header>
        <div className="modal-body">
          <input ref={input} className="input" type="search" value={filter} placeholder={t("Type to filter…")} aria-label={t("Type to filter…")} onChange={(event) => setFilter(event.target.value)} />
          <ul className="shortcuts-help-list">
            {shown.map((row) => (
              <li key={row.id} className="shortcuts-help-row">
                <span>{row.label}</span>
                <span className="shortcuts-help-keys">{row.keys.map((key, index) => <kbd className="kbd" key={`${key}-${index}`}>{key}</kbd>)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}
