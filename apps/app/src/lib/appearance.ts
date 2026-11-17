import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, native } from "./api";
import { readPageTransition, type PageTransition } from "./usePageTransition";
import { changeTheme } from "./themeTransition";

export type ThemePreference = "system" | "light" | "dark";
export type SidebarPreference = "auto" | "expanded" | "collapsed";
export interface Appearance {
  theme: ThemePreference;
  scale: number;
  sidebar: SidebarPreference;
  transition: PageTransition;
  accent: "system" | "custom";
  accentColor: string;
}
export const defaultAccent = "#0f6cbd";
export function isMobileDevice() {
  return (
    typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
  );
}
export const defaultAppearance: Appearance = {
  theme: "system",
  scale: isMobileDevice() ? 75 : 100,
  sidebar: "auto",
  transition: "slide",
  accent: "system",
  accentColor: defaultAccent,
};
export function readAppearance(): Appearance {
  let saved: Partial<Appearance> = {};
  try {
    saved = JSON.parse(localStorage.getItem("atorch-appearance") ?? "{}") ?? {};
  } catch {
    /* Use defaults for invalid preferences. */
  }
  const legacy = localStorage.getItem("atorch-theme");
  return {
    ...defaultAppearance,
    theme: ["system", "light", "dark"].includes(saved.theme ?? "")
      ? saved.theme!
      : legacy === "dark" || legacy === "light"
        ? legacy
        : "system",
    scale:
      Number.isFinite(saved.scale) && saved.scale! >= 50 && saved.scale! <= 200
        ? saved.scale!
        : defaultAppearance.scale,
    sidebar:
      saved.sidebar === "expanded" || saved.sidebar === "collapsed"
        ? saved.sidebar
        : "auto",
    transition:
      saved.transition === "slide" ||
      saved.transition === "fade" ||
      saved.transition === "scale" ||
      saved.transition === "none"
        ? saved.transition
        : readPageTransition(),
    accent: saved.accent === "custom" ? "custom" : "system",
    accentColor: /^#[0-9a-f]{6}$/i.test(saved.accentColor ?? "")
      ? saved.accentColor!
      : defaultAccent,
  };
}
async function readSystemDark() {
  // A forced Windows window theme can change matchMedia. Query the OS instead.
  if (native) {
    try {
      const dark = await api.systemTheme();
      if (dark !== null && dark !== undefined) return dark;
    } catch {
      /* Older hosts and other platforms retain the media-query fallback. */
    }
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
export function useAppearance(
  value: Appearance,
  onChange: (next: Appearance) => void,
) {
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [systemAccent, setSystemAccent] = useState(defaultAccent);
  const system = useRef(systemDark);
  const current = useRef(value);
  current.current = value;
  const applyAppearance = async (next: Appearance) => {
    const systemDark =
      next.theme === "system" ? await readSystemDark() : system.current;
    const oldDark =
      current.current.theme === "system"
        ? system.current
        : current.current.theme === "dark";
    const newDark =
      next.theme === "system" ? systemDark : next.theme === "dark";
    changeTheme(() => {
      system.current = systemDark;
      setSystemDark(systemDark);
      onChange(next);
    }, oldDark !== newDark);
  };
  const mobileDevice = isMobileDevice();
  const readViewport = () => ({
    width: innerWidth,
    landscape: screen.orientation?.type
      ? screen.orientation.type.startsWith("landscape")
      : typeof window.orientation === "number"
        ? Math.abs(window.orientation) === 90
        : innerWidth > innerHeight,
  });
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    let alive = true;
    let request = 0;
    const refresh = async (animate: boolean) => {
      const id = ++request;
      const dark = await readSystemDark();
      if (!alive || id !== request || dark === system.current) return;
      changeTheme(
        () => {
          system.current = dark;
          setSystemDark(dark);
        },
        animate && current.current.theme === "system",
      );
    };
    const change = () => void refresh(true);
    void refresh(false);
    media.addEventListener("change", change);
    window.addEventListener("focus", change);
    const resize = () => setViewport(readViewport());
    window.addEventListener("resize", resize);
    screen.orientation?.addEventListener("change", resize);
    return () => {
      alive = false;
      media.removeEventListener("change", change);
      window.removeEventListener("focus", change);
      window.removeEventListener("resize", resize);
      screen.orientation?.removeEventListener("change", resize);
    };
  }, []);
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const update = () =>
      void api
        .systemAccent()
        .then((color) => {
          if (alive && color && /^#[0-9a-f]{6}$/i.test(color))
            setSystemAccent(color);
        })
        .catch(() => {});
    update();
    window.addEventListener("focus", update);
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      alive = false;
      window.removeEventListener("focus", update);
      media.removeEventListener("change", update);
    };
  }, []);
  const scale = value.scale / 100;
  const mobileLayout = mobileDevice
    ? !viewport.landscape
    : viewport.width / scale <= 650;
  const collapsed =
    value.sidebar === "collapsed" ||
    (value.sidebar === "auto" && viewport.width / scale <= 1200);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--ui-scale", String(scale));
    localStorage.setItem("atorch-appearance", JSON.stringify(value));
    localStorage.setItem("atorch-theme", value.theme);
    return () => {
      style.removeProperty("--ui-scale");
    };
  }, [value, scale]);
  return {
    scale,
    mobileDevice,
    mobileLayout,
    collapsed,
    dark: value.theme === "system" ? systemDark : value.theme === "dark",
    accent: value.accent === "system" ? systemAccent : value.accentColor,
    systemAccent,
    applyAppearance,
  };
}
