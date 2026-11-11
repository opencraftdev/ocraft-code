import { useEffect, useRef, useState, type ReactNode } from "react";
import { FolderSearch, X } from "lucide-react";

import "./FilesDialog.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { RepoChanges } from "./RepoChanges.tsx";
import type { RepoDiffFile } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import type { RepoComparison } from "../lib/repoDiff.ts";
import { nativeModalOver, useFocusReturn, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

export interface FilesDialogProps {
  initialTab?: "browse" | "changes";
  /** the folder to open at: the pane's own */
  start: string;
  /** the pane whose repository's changes are listed */
  paneId: string;
  /** a file or a diff is open above this dialog: Escape belongs to it, which closes first */
  viewing: boolean;
  onOpenFile: (path: string) => void;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile) => void;
  /** the command palette, already browsing this folder (it opens above this dialog) */
  onBrowseFolders: (path: string) => void;
  onClose: () => void;
  /** A desktop workspace column; the chat stays usable while browsing. */
  docked?: boolean;
  panelStart?: ReactNode;
  keyboardActive?: boolean;
}

type Tab = "browse" | "changes";

/** The files of the pane's folder (and any other), each opened in the file viewer, and the changes of its repository, each opened as a diff. */
export function FilesDialog({ initialTab = "browse", start, paneId, viewing, onOpenFile, onOpenDiff, onBrowseFolders, onClose, docked = false, panelStart, keyboardActive = true }: FilesDialogProps) {
  const t = useT();
  const phone = useMediaQuery("(max-width: 480px)");
  const surface = useFocusTrap<HTMLElement>(!docked);
  useFocusReturn(docked);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [browseVisited, setBrowseVisited] = useState(initialTab === "browse");
  // the changes are read with the first visit and kept, as the browser keeps its folder
  const [changesVisited, setChangesVisited] = useState(initialTab === "changes");
  useSheetSwipe(surface, docked ? null : onClose);
  // a file opened from the list is drawn over it with an entry of its own: Back closes the file first
  usePhoneSheetBack(onClose, !docked && !viewing);
  useEffect(() => { if (docked) surface.current?.focus({ preventScroll: true }); }, [docked]);
  useEffect(() => {
    if (viewing || !keyboardActive) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || nativeModalOver(surface.current)) return;
      if (docked && !surface.current?.contains(document.activeElement)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing, docked, keyboardActive]);
  const show = (next: Tab): void => {
    setTab(next);
    if (next === "browse") setBrowseVisited(true);
    if (next === "changes") setChangesVisited(true);
  };
  // the folder the browser shows now (it tells each one it opens), for the pane it showed it for;
  // else the one the dialog opened at
  const folder = useRef<{ pane: string; path: string } | null>(null);
  const browseFolders = (): void => onBrowseFolders(folder.current?.pane === paneId ? folder.current.path : (start || "~"));
  const content = <>
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          <div className="segmented files-dialog-tabs" role="group" aria-label={t("Show")}>
            <button type="button" aria-pressed={tab === "browse"} onClick={() => show("browse")}>{t("Browse")}</button>
            <button type="button" aria-pressed={tab === "changes"} onClick={() => show("changes")}>{t("Changes")}</button>
          </div>
          {!phone && <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={browseFolders}><FolderSearch aria-hidden="true" /></button>}
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {/* the dialog stays open across a pane switch (Next pane): the browser starts over on the new
              pane's folder, as Changes reads the new pane, instead of listing the pane it was opened on */}
          {browseVisited && <div hidden={tab !== "browse"}><DirectoryBrowser key={paneId} start={start} onOpenFile={onOpenFile} onFolder={(path) => { folder.current = { pane: paneId, path }; }} /></div>}
          {changesVisited && <div hidden={tab !== "changes"}><RepoChanges paneId={paneId} directory={start} onOpenDiff={onOpenDiff} /></div>}
        </div>
  </>;
  if (docked) return <aside ref={surface} className="file-panel files-panel" aria-labelledby="files-dialog-title" tabIndex={-1}>
    {panelStart}
    <section className="files-dialog files-browser-docked">{content}</section>
  </aside>;
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1}>{content}</section>
    </div>
  );
}
