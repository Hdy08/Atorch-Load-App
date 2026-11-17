import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  AutomaticConnection,
  type AutoConnectionPhase,
  type AutoConnectPreference,
} from "./autoConnect";
import type { Snapshot } from "./types";

export function useAutoConnect(
  enabled: boolean,
  onConnected: (snapshot: Snapshot) => void,
  preference: AutoConnectPreference = "prefer-usb",
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
  const activation = useRef(0);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    const generation = ++activation.current;
    void controller.configure(preference).then(() => {
      if (generation === activation.current)
        return controller.setEnabled(
          enabled && visible && preference !== "off",
        );
    });
    return () => {
      ++activation.current;
      void controller.setEnabled(false);
    };
  }, [controller, enabled, visible, preference]);
  const suspend = useCallback(() => {
    ++activation.current;
    return controller.setEnabled(false);
  }, [controller]);
  return { phase, suspend };
}
