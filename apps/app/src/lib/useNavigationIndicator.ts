import { useLayoutEffect, type RefObject } from "react";

/** Keep one sliding underline beneath the selected portrait navigation item. */
export function useNavigationIndicator(
  app: RefObject<HTMLDivElement | null>,
  page: string,
  mobileLayout: boolean,
  scale: number,
) {
  useLayoutEffect(() => {
    if (!mobileLayout) return;
    const sidebar = app.current?.querySelector<HTMLElement>(".sidebar");
    const selected = sidebar?.querySelector<HTMLElement>(
      '.nav-item[aria-current="page"]',
    );
    if (!sidebar || !selected) return;
    const measure = () => {
      const container = sidebar.getBoundingClientRect();
      const item = selected.getBoundingClientRect();
      const width = Math.max(0, Math.min(32, item.width / scale - 16));
      sidebar.style.setProperty("--nav-indicator-width", `${width}px`);
      sidebar.style.setProperty(
        "--nav-indicator-left",
        `${(item.left - container.left) / scale + (item.width / scale - width) / 2}px`,
      );
      sidebar.style.setProperty(
        "--nav-indicator-top",
        `${(item.bottom - container.top) / scale - 3}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar);
    observer.observe(selected);
    return () => observer.disconnect();
  }, [app, page, mobileLayout, scale]);
}
