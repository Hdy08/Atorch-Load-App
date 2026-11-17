import { useEffect, type RefObject } from "react";

/** Reveal the page scrollbar during scrolling or when approaching its edge. */
export function usePageScrollbar(app: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const shell = app.current?.querySelector<HTMLElement>(".main-shell");
    if (!shell) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      if (shell.scrollHeight <= shell.clientHeight) return;
      shell.classList.add("scrollbar-visible");
      clearTimeout(timer);
      timer = setTimeout(
        () => shell.classList.remove("scrollbar-visible"),
        1000,
      );
    };
    const approach = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const right = window.innerWidth;
      if (event.clientX >= right - 16 && event.clientX <= right) show();
    };
    shell.addEventListener("scroll", show, { passive: true });
    shell.addEventListener("wheel", show, { passive: true });
    shell.addEventListener("pointermove", approach, { passive: true });
    return () => {
      clearTimeout(timer);
      shell.classList.remove("scrollbar-visible");
      shell.removeEventListener("scroll", show);
      shell.removeEventListener("wheel", show);
      shell.removeEventListener("pointermove", approach);
    };
  }, [app]);
}
