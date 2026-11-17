import { useLayoutEffect, useState, type RefObject } from "react";

export interface PageLayout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  contentLeft: number;
  contentRight: number;
  contentWidth: number;
  controlTop: number;
  notificationTop: number;
  scale: number;
}

/** Measure the same content edges for the cards and their floating controls. */
export function usePageLayout(
  app: RefObject<HTMLDivElement | null>,
  page: string,
  customTitlebar: boolean,
  scale = 1,
  mobileLayout = false,
  collapsed = false,
): PageLayout | null {
  const [layout, setLayout] = useState<PageLayout | null>(null);
  useLayoutEffect(() => {
    const root = app.current;
    const shell = root?.querySelector<HTMLElement>(".main-shell");
    const main = root?.querySelector<HTMLElement>("main");
    const sidebar = root?.querySelector<HTMLElement>(".sidebar");
    if (!root || !shell || !main || !sidebar) return;
    const actions = main.querySelector<HTMLElement>(
      ".application-settings-actions",
    );
    const controlSpace = main.querySelector<HTMLElement>(
      ".load-control-placeholder",
    );
    const measure = () => {
      // The scrollbar occupies part of the requested inset, not an extra inset.
      root.style.setProperty(
        "--page-scrollbar",
        `${shell.offsetWidth - shell.clientWidth}px`,
      );
      const viewport = shell.getBoundingClientRect();
      const navigation = sidebar.getBoundingClientRect();
      root.style.setProperty(
        "--page-navigation-height",
        `${mobileLayout ? navigation.height / scale : 0}px`,
      );
      const padding = getComputedStyle(main);
      const mainLeft = viewport.left;
      const contentLeft = mainLeft + parseFloat(padding.paddingLeft) * scale;
      const contentRight =
        mainLeft +
        (main.offsetWidth - parseFloat(padding.paddingRight)) * scale;
      const controlTop =
        viewport.top +
        (controlSpace
          ? controlSpace.getBoundingClientRect().top -
            main.getBoundingClientRect().top
          : parseFloat(padding.paddingTop) * scale);
      const next: PageLayout = {
        left: viewport.left,
        right: viewport.left + shell.clientWidth * scale,
        top: viewport.top,
        bottom: Math.min(
          viewport.bottom,
          navigation.top > viewport.top ? navigation.top : viewport.bottom,
        ),
        contentLeft,
        contentRight,
        contentWidth: contentRight - contentLeft,
        controlTop,
        // Relative bounds cancel the page transition transform and scroll.
        notificationTop: actions
          ? viewport.top +
            actions.getBoundingClientRect().bottom -
            main.getBoundingClientRect().top +
            16 * scale
          : controlTop,
        scale,
      };
      setLayout((previous) =>
        previous &&
        (Object.keys(next) as (keyof PageLayout)[]).every(
          (key) => Math.abs(previous[key] - next[key]) < 0.5,
        )
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [shell, main, sidebar]) observer.observe(element);
    if (actions) observer.observe(actions);
    if (controlSpace) observer.observe(controlSpace);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [app, page, customTitlebar, scale, mobileLayout, collapsed]);
  return layout;
}
