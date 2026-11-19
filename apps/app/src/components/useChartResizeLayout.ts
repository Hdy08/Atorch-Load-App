import { useEffect, useRef } from "react";

/** Keep shrinking content from clamping scrollTop underneath a captured drag. */
export function useChartResizeLayout() {
  const guard = useRef<{
    shell: HTMLElement;
    main: HTMLElement;
    previous: string;
    active: boolean;
    reconcile: () => void;
    dispose: () => void;
  } | null>(null);
  const frame = useRef(0);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      guard.current?.dispose();
    },
    [],
  );

  const begin = (handle: HTMLElement) => {
    cancelAnimationFrame(frame.current);
    if (guard.current) {
      guard.current.active = true;
      return;
    }
    const main = handle.closest("main");
    const shell = main?.closest<HTMLElement>(".main-shell");
    if (!main || !shell) return;
    const previous = main.style.minHeight;
    const state = {
      shell,
      main,
      previous,
      active: true,
      reconcile: () => {},
      dispose: () => {},
    };
    const reserve = () => {
      main.style.minHeight = `max(${previous || "0px"}, ${Math.ceil(shell.scrollTop + shell.clientHeight)}px)`;
    };
    state.dispose = () => {
      shell.removeEventListener("scroll", state.reconcile);
      window.removeEventListener("resize", state.reconcile);
      main.style.minHeight = previous;
      guard.current = null;
    };
    state.reconcile = () => {
      if (state.active) return;
      const last = main.lastElementChild as HTMLElement | null;
      const scale =
        Number(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--ui-scale",
          ),
        ) || 1;
      const naturalHeight = last
        ? (last.getBoundingClientRect().bottom -
            main.getBoundingClientRect().top) /
            scale +
          parseFloat(getComputedStyle(main).paddingBottom)
        : 0;
      // Remove only space the user has already scrolled past, so releasing
      // the handle cannot introduce the same jump one frame later.
      if (
        shell.scrollTop <= 1 ||
        naturalHeight >= shell.scrollTop + shell.clientHeight - 1
      )
        state.dispose();
      else reserve();
    };
    guard.current = state;
    reserve();
    shell.addEventListener("scroll", state.reconcile, { passive: true });
    window.addEventListener("resize", state.reconcile);
  };
  const end = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (!guard.current) return;
      guard.current.active = false;
      guard.current.reconcile();
    });
  };
  return { begin, end };
}
