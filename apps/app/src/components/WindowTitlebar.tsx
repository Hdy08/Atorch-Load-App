import { useEffect, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import {
  Dismiss16Regular,
  Square16Regular,
  SquareMultiple16Regular,
  Subtract16Regular,
} from "@fluentui/react-icons";
import { api } from "../lib/api";

export function WindowTitlebar() {
  const [maximized, setMaximized] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const update = () =>
      void api
        .windowAction("state")
        .then((value) => {
          if (alive) setMaximized(value);
        })
        .catch((error) => console.warn("窗口状态读取失败", error));
    update();
    window.addEventListener("resize", update);
    return () => {
      alive = false;
      window.removeEventListener("resize", update);
    };
  }, []);
  const act = (action: "minimize" | "maximize" | "close" | "drag") => {
    void api
      .windowAction(action)
      .then(setMaximized)
      .catch((error) => console.warn("窗口操作失败", error));
  };
  return (
    <header className="window-titlebar" aria-label="窗口标题栏">
      <div
        className="window-drag-region"
        onPointerDown={(event) => {
          if (event.button === 0)
            dragStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          const start = dragStart.current;
          if (
            start &&
            event.buttons & 1 &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4
          ) {
            dragStart.current = null;
            act("drag");
          }
        }}
        onPointerUp={() => {
          dragStart.current = null;
        }}
        onPointerLeave={() => {
          dragStart.current = null;
        }}
        onDoubleClick={() => {
          dragStart.current = null;
          act("maximize");
        }}
      >
        <span>Atorch Load</span>
      </div>
      <div className="window-controls">
        <Button
          appearance="subtle"
          aria-label="最小化"
          icon={<Subtract16Regular />}
          onClick={() => act("minimize")}
        />
        <Button
          appearance="subtle"
          aria-label={maximized ? "还原窗口" : "最大化"}
          icon={maximized ? <SquareMultiple16Regular /> : <Square16Regular />}
          onClick={() => act("maximize")}
        />
        <Button
          appearance="subtle"
          className="window-close"
          aria-label="关闭窗口"
          icon={<Dismiss16Regular />}
          onClick={() => act("close")}
        />
      </div>
    </header>
  );
}
