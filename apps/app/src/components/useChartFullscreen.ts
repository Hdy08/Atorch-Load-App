import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, native } from "../lib/api";

const mobileDevice = () =>
  matchMedia("(pointer: coarse)").matches ||
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Keep enter/leave ordered even if the view closes before Android has rotated.
let nativeTransition = Promise.resolve();
function setNativeFullscreen(enabled: boolean) {
  nativeTransition = nativeTransition
    .catch(() => {})
    .then(() => api.chartFullscreen(enabled));
  return nativeTransition;
}

export function useChartFullscreen() {
  const viewport = useRef<HTMLDialogElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const browserFullscreen = useRef(false);
  const mobile = mobileDevice();
  const rotate = fullscreen && mobile && size.height > size.width;

  const enter = () => {
    setFullscreen(true);
    if (!mobile || native || !document.documentElement.requestFullscreen)
      return;
    // Request while the button still owns the browser's user activation.
    browserFullscreen.current = true;
    void document.documentElement
      .requestFullscreen()
      .then(async () => {
        if (!browserFullscreen.current) {
          if (document.fullscreenElement) await document.exitFullscreen();
          return;
        }
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (mode: string) => Promise<void>;
        };
        await orientation.lock?.("landscape");
        if (!browserFullscreen.current) orientation.unlock?.();
      })
      .catch(() => {
        // WebViews/iOS may reject orientation locking. The viewport rotates
        // instead, so the chart still has a landscape layout.
      });
  };

  useEffect(() => {
    if (!fullscreen) return;
    const resize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    resize();
    window.addEventListener("resize", resize);
    const leave = () => setFullscreen(false);
    const browserChange = () => {
      if (browserFullscreen.current && !document.fullscreenElement) leave();
    };
    window.addEventListener("atorch-chart-fullscreen-exit", leave);
    document.addEventListener("fullscreenchange", browserChange);
    const restoreNative = () => {
      if (native && mobile) void setNativeFullscreen(false).catch(() => {});
    };
    window.addEventListener("pagehide", restoreNative);
    if (native && mobile) void setNativeFullscreen(true).catch(() => {});
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("atorch-chart-fullscreen-exit", leave);
      document.removeEventListener("fullscreenchange", browserChange);
      window.removeEventListener("pagehide", restoreNative);
      restoreNative();
      if (browserFullscreen.current) {
        browserFullscreen.current = false;
        screen.orientation?.unlock?.();
        if (document.fullscreenElement)
          void document.exitFullscreen().catch(() => {});
      }
    };
  }, [fullscreen, mobile]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !fullscreen) return;
    const focused = document.activeElement as HTMLElement | null;
    const { scrollX, scrollY } = window;
    const rootStyle = document.documentElement.style;
    const previousOverflow = rootStyle.overflow;
    const previousGutter = rootStyle.scrollbarGutter;
    rootStyle.overflow = "hidden";
    rootStyle.scrollbarGutter = "auto";
    // The same chart enters the top layer. No ECharts instance, data or zoom
    // is recreated, and card clipping cannot limit the fullscreen viewport.
    element.close();
    element.showModal();
    return () => {
      element.close();
      if (element.isConnected) element.show();
      rootStyle.overflow = previousOverflow;
      rootStyle.scrollbarGutter = previousGutter;
      focused?.focus({ preventScroll: true });
      window.scrollTo(scrollX, scrollY);
    };
  }, [fullscreen]);

  return {
    viewport,
    fullscreen,
    rotate,
    chartHeight:
      (rotate ? size.width : size.height) /
      (Number(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--ui-scale",
        ),
      ) || 1),
    enter,
    exit: () => setFullscreen(false),
  };
}
