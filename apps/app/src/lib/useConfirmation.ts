import { useState } from "react";

export function useConfirmation<T>() {
  const [state, setState] = useState<{ data: T; open: boolean } | null>(null);

  return {
    data: state?.data,
    open: state?.open ?? false,
    show: (data: T) => setState({ data, open: true }),
    // Fluent keeps the surface visible while its exit animation runs.
    close: () =>
      setState((current) =>
        current?.open ? { ...current, open: false } : current,
      ),
  };
}
