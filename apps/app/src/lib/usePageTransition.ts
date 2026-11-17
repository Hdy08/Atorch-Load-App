import { useLayoutEffect, useRef, type RefObject } from "react";
import { tokens } from "@fluentui/react-components";

export type PageTransition = "slide" | "fade" | "scale" | "none";
export function readPageTransition(): PageTransition {
  const saved = localStorage.getItem("atorch-page-transition");
  return saved === "fade" || saved === "scale" || saved === "none"
    ? saved
    : "slide";
}

/** Animate the incoming page with the WebView's compositor, without snapshots. */
export function usePageTransition(
  main: RefObject<HTMLElement | null>,
  page: string,
  transition: PageTransition,
) {
  const previous = useRef(page);
  useLayoutEffect(() => {
    localStorage.setItem("atorch-page-transition", transition);
    if (previous.current === page) return;
    previous.current = page;
    const element = main.current;
    element?.parentElement?.scrollTo({ top: 0, behavior: "instant" });
    if (
      !element ||
      transition === "none" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const style = getComputedStyle(element);
    const token = (value: string) =>
      style.getPropertyValue(value.slice(4, -1)).trim();
    const animation = element.animate(
      [
        {
          opacity: 0,
          transform:
            transition === "slide"
              ? "translateY(12px)"
              : transition === "scale"
                ? "scale(0.985)"
                : "none",
        },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: parseFloat(token(tokens.durationNormal)) || 200,
        easing:
          token(tokens.curveDecelerateMid) || "cubic-bezier(0.1, 0.9, 0.2, 1)",
      },
    );
    return () => animation.cancel();
  }, [main, page, transition]);
}
