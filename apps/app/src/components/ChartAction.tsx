import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Button, Tooltip, type ButtonProps } from "@fluentui/react-components";

export function ChartAction({
  label,
  className = "",
  ...props
}: Omit<ComponentPropsWithoutRef<"button">, "children"> &
  Pick<ButtonProps, "icon" | "appearance"> & { label: string }) {
  return (
    <Tooltip content={label} relationship="description">
      <Button
        {...props}
        as="button"
        className={`chart-action ${className}`}
        aria-label={label}
      >
        <span className="chart-action-label">{label}</span>
      </Button>
    </Tooltip>
  );
}

/** Keep every action available, switching the whole row to icons when needed. */
export function ChartActions({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const requiredWidth = useRef<number | undefined>(undefined);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current!;
    const buttons = [...element.querySelectorAll<HTMLElement>(".chart-action")];
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    // Measure the expanded row once, before paint. Retain this width when the
    // labels are hidden, so crossing the breakpoint cannot alternate layouts.
    const expandedWidth = (requiredWidth.current ??=
      buttons.reduce((sum, button) => sum + button.offsetWidth, 0) +
      Math.max(0, buttons.length - 1) * gap);
    const update = () => setCompact(element.clientWidth + 0.5 < expandedWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`chart-image-actions${compact ? " icon-only" : ""}`}
    >
      {children}
    </div>
  );
}
