import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
document.addEventListener("contextmenu", (event) => event.preventDefault(), {
  capture: true,
});
const browserKeys = new Set([
  "f1",
  "f3",
  "f5",
  "f6",
  "f7",
  "f11",
  "f12",
  "browserback",
  "browserforward",
  "browserrefresh",
]);
const browserCommands = new Set([
  "r",
  "p",
  "s",
  "o",
  "l",
  "n",
  "t",
  "w",
  "d",
  "h",
  "j",
  "f",
  "u",
  "+",
  "=",
  "-",
  "0",
]);
document.addEventListener(
  "keydown",
  (event) => {
    const key = event.key.toLowerCase();
    if (
      browserKeys.has(key) ||
      ((event.ctrlKey || event.metaKey) &&
        (browserCommands.has(key) ||
          (event.shiftKey && ["i", "j", "c"].includes(key)))) ||
      (event.altKey && ["arrowleft", "arrowright", "home"].includes(key))
    )
      event.preventDefault();
  },
  { capture: true },
);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
