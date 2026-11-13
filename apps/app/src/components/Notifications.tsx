import { useEffect, useId, useRef } from "react";
import {
  Button,
  Toast,
  Toaster,
  ToastTitle,
  ToastTrigger,
  useToastController,
} from "@fluentui/react-components";

export function Notifications({
  message,
}: {
  message: { text: string; error: boolean; intent?: "info" } | null;
}) {
  const toasterId = useId();
  const sequence = useRef(0);
  const { dispatchToast, dismissToast, dismissAllToasts } =
    useToastController(toasterId);
  useEffect(() => {
    if (!message) return;
    dismissAllToasts();
    const toastId = `${toasterId}-${++sequence.current}`;
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
          {message.text}
        </ToastTitle>
      </Toast>,
      {
        toastId,
        intent: message.intent ?? (message.error ? "error" : "success"),
      },
    );
    // Fluent starts its animation timer after the entry transition and pauses
    // it on focus. Close three seconds after dispatch, including those cases.
    const timer = setTimeout(() => dismissToast(toastId), 3000);
    return () => clearTimeout(timer);
  }, [message, dispatchToast, dismissToast, dismissAllToasts, toasterId]);
  return (
    <Toaster
      toasterId={toasterId}
      position="top-end"
      timeout={3000}
      pauseOnHover={false}
      pauseOnWindowBlur={false}
      limit={1}
      className="app-notifications"
    />
  );
}
