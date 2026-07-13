import React from "react";
import ReactDOM from "react-dom/client";
import { initTheme } from "@/lib/theme";
import { App } from "./App";
import "@/assets/styles.css";

// Before first render: MV3 CSP forbids inline scripts in index.html, so this
// is the earliest point the theme class can be applied (see lib/theme.ts).
initTheme();

// #root is guaranteed by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
