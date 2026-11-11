import { useEffect, useState } from "react";
import { usePageVisible } from "./visibility.ts";

/** Tick only while a visible panel has work running. All task timestamps use the PC's clock. */
export function useActivityClock(running: boolean, offset: number): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!running || !visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, visible, offset]);
  return now + offset;
}
