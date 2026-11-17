import { flushSync } from "react-dom";

let active: ViewTransition | undefined;
let revision = 0;

/** Let the WebView composite the old/new theme; never animate the initial load. */
export function changeTheme(update: () => void, animate: boolean) {
  const request = ++revision;
  active?.skipTransition();
  if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  if (document.startViewTransition) {
    const transition = document.startViewTransition(() => {
      if (request === revision) flushSync(update);
    });
    active = transition;
    void transition.ready.catch(() => {});
    void transition.finished
      .catch(() => {})
      .finally(() => {
        if (active === transition) active = undefined;
      });
  } else {
    update();
    document
      .querySelector(".theme-root")
      ?.animate([{ opacity: 0.75 }, { opacity: 1 }], {
        duration: 200,
        easing: "ease-out",
      });
  }
}
