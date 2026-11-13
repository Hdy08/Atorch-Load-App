import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { AutomaticConnection, type AutoConnectionPhase } from "./autoConnect";
import type { Snapshot } from "./types";

export function useAutoConnect(
  enabled: boolean,
  onConnected: (snapshot: Snapshot) => void,
) {
  const callback = useRef(onConnected);
  callback.current = onConnected;
  const [phase, setPhase] = useState<AutoConnectionPhase>("idle");
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [controller] = useState(
    () =>
      new AutomaticConnection(api, setPhase, (next) => callback.current(next)),
  );
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    void controller.setEnabled(enabled && visible);
    return () => {
      void controller.setEnabled(false);
    };
  }, [controller, enabled, visible]);
  const suspend = useCallback(() => controller.setEnabled(false), [controller]);
  return { phase, suspend };
}
