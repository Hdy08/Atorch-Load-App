import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  Button,
  Toast,
  Toaster,
  ToastTitle,
  ToastTrigger,
  useToastController,
} from "@fluentui/react-components";
import type { PageLayout } from "../lib/usePageLayout";

type Notice = {
  text: string;
  error: boolean;
  intent?: "info" | "warning";
};
const NotificationContext = createContext<(notice: Notice) => void>(() => {});

export function useNotify() {
  return useContext(NotificationContext);
}

/** Show a changing status once without reserving space in the page. */
export function Notification({
  text,
  error = false,
  intent,
}: {
  text: string | null | undefined;
  error?: boolean;
  intent?: Notice["intent"];
}) {
  const notify = useNotify();
  useEffect(() => {
    if (text) notify({ text, error, intent });
  }, [text, error, intent, notify]);
  return null;
}

export function Notifications({
  message,
  loadControlVisible = false,
  layout,
  children,
}: {
  message: Notice | null;
  loadControlVisible?: boolean;
  layout?: PageLayout | null;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    if (!layout) return;
    // Fluent mutates the Toaster slot's style object while positioning it.
    // Keep dynamic bounds on inherited variables rather than React's frozen props.
    style.setProperty(
      "--page-notification-right",
      `${(window.innerWidth - layout.contentRight) / layout.scale}px`,
    );
    style.setProperty(
      "--page-notification-width",
      `${layout.contentWidth / layout.scale}px`,
    );
    style.setProperty(
      "--page-notification-top",
      `${loadControlVisible ? layout.controlTop / layout.scale + 60 : layout.notificationTop / layout.scale}px`,
    );
    return () => {
      for (const name of ["right", "width", "top"])
        style.removeProperty(`--page-notification-${name}`);
    };
  }, [layout, loadControlVisible]);
  const toasterId = useId();
  const sequence = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const errors = useRef(new Map<string, string>());
  const { dispatchToast, dismissToast, dismissAllToasts } =
    useToastController(toasterId);
  const notify = useCallback(
    (notice: Notice) => {
      // Polling and duplicate error sources must not stack the same failure.
      // Dismissed failures can be shown again on the next attempt.
      if (notice.error && errors.current.has(notice.text)) return;
      const toastId = `${toasterId}-${++sequence.current}`;
      if (notice.error) errors.current.set(notice.text, toastId);
      dispatchToast(
        <Toast>
          <ToastTitle
            action={
              <ToastTrigger>
                <Button appearance="transparent" size="small">
                  关闭
                </Button>
              </ToastTrigger>
            }
          >
            {notice.text}
          </ToastTitle>
        </Toast>,
        {
          toastId,
          intent: notice.intent ?? (notice.error ? "error" : "success"),
          timeout: -1,
          onStatusChange: (_, { status }) => {
            // StrictMode reports "unmounted" during its effect replay too.
            // Only an actual dismissal should cancel this lifetime.
            if (status === "dismissed") {
              clearTimeout(timers.current.get(toastId));
              timers.current.delete(toastId);
              if (errors.current.get(notice.text) === toastId)
                errors.current.delete(notice.text);
            }
          },
        },
      );
      // Focus, hover and entry animations cannot extend this lifetime.
      // Failures have no expiry and are not replaced by later successes.
      if (!notice.error)
        timers.current.set(
          toastId,
          setTimeout(() => {
            timers.current.delete(toastId);
            dismissToast(toastId);
          }, 3000),
        );
    },
    [dispatchToast, dismissToast, toasterId],
  );
  useEffect(() => {
    if (message) notify(message);
  }, [message, notify]);
  useEffect(() => {
    const activeTimers = timers.current;
    const activeErrors = errors.current;
    return () => {
      dismissAllToasts();
      for (const timer of activeTimers.values()) clearTimeout(timer);
      activeTimers.clear();
      activeErrors.clear();
    };
  }, [dismissAllToasts]);
  return (
    <NotificationContext.Provider value={notify}>
      <Toaster
        toasterId={toasterId}
        position="top-end"
        timeout={-1}
        pauseOnHover={false}
        pauseOnWindowBlur={false}
        className={`app-notifications${loadControlVisible ? " with-load-control" : ""}`}
      />
      {children}
    </NotificationContext.Provider>
  );
}
