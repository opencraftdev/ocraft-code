import type { ReactNode } from "react";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useT } from "../lib/i18n.ts";
import "./AgentPanel.css";

/** Files and previews occupy the same right-hand position as agent/task details. */
export function WorkspaceFileDrawer({ children, onClose, browser, covered }: { children: ReactNode; onClose: () => void; browser: boolean; covered: boolean }) {
  const t = useT();
  usePhoneSheetBack(onClose, browser && !covered, true);
  return <aside className="workspace-details-drawer workspace-file-drawer" aria-label={t("Files")}>{children}</aside>;
}
