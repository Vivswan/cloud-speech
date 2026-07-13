import React from "react";
import ReactDOM from "react-dom/client";
import { initI18n } from "@/lib/i18n-runtime";
import { initTheme } from "@/lib/theme";
import { App } from "./App";
import "@/assets/styles.css";

// Before first render: MV3 CSP forbids inline scripts in index.html, so this
// is the earliest point the theme class can be applied (see lib/theme.ts).
initTheme();

// Gate first paint on the chosen-locale messages so the popup never flashes
// English. initI18n never rejects (load failures degrade t() to the
// browser-locale getMessage), so render always runs.
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
