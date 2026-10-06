import React from "react";
import ReactDOM from "react-dom/client";
import { initI18n } from "@/lib/text/i18n-runtime";
import { initTheme } from "@/lib/theme";
import { addFaces } from "@/lib/ui/font-loader";
import { TYPEFACES } from "@/lib/ui/fonts";
import { App } from "./App";
import "@/assets/styles.css";

// MV3 CSP forbids inline scripts in index.html, so this is the earliest point the theme class can
// be applied (see lib/theme.ts).
initTheme();

// The bundled typefaces behind the `--font-sans`/`--font-mono` tokens.
for (const typeface of TYPEFACES) addFaces(document.fonts, typeface);

// First paint waits for the chosen-locale messages so the popup never flashes English. initI18n
// never rejects (load failures degrade t() to the browser-locale getMessage).
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
