import { extname } from "node:path";
import { SITE_LOCALES, type StoreLocale } from "@cloud-speech/constants";
import {
  FALLBACK_LOCALE,
  RENDER_DIR,
  renderFinished,
  STORE_SCREENSHOTS_DIR,
} from "@cloud-speech/store-screenshots";
import sirv from "sirv";
import type { Connect, Plugin } from "vite";

// Dev-only: serves the local render in the published branch's layout, at the URLs @cloud-speech/store-screenshots
// hands the walkthrough pages in dev. A missing or unfinished file falls through to Astro's 404, so the page falls
// back exactly as it does against the branch. Astro strips the site base before a Vite middleware sees the request,
// so the paths here are bare.
//   /store-screenshots/<locale>/<file>  -> that locale's set
//   /store-screenshots/<file>           -> the English set

const FILE_TYPES = new Set([".jpg", ".json"]);

export interface SetFile {
  /** The request's directory, or the fallback set for a file at the root. */
  locale: StoreLocale;
  name: string;
}

/** A set is flat: a name with a separator or a leading dot is not one of its files, whatever it would
 *  resolve to. */
export function setFile(url: string): SetFile | undefined {
  const path = url.split("?")[0] ?? "";
  const prefix = `/${STORE_SCREENSHOTS_DIR}/`;
  if (!path.startsWith(prefix)) return undefined;
  const segments = decodeURIComponent(path.slice(prefix.length)).split("/");
  const name = segments.pop() ?? "";
  if (!FILE_TYPES.has(extname(name)) || name.includes("\\") || name.startsWith(".")) return;
  if (segments.length === 0) return { locale: FALLBACK_LOCALE, name };
  if (segments.length > 1) return;
  const locale = SITE_LOCALES.find((candidate) => candidate.storeLocale === segments[0]);
  return locale && { locale: locale.storeLocale, name };
}

/** The render's own layout is <locale>/<file>, so a root URL is re-pointed at the fallback set before sirv looks
 *  the file up, and restored when sirv has nothing, so Astro's 404 names the URL that was asked for. */
export function renderedScreenshotsHandler(
  renderDir: string = RENDER_DIR,
): Connect.NextHandleFunction {
  // dev: one lookup per request, so a re-render shows on reload (sirv then also sends Cache-Control: no-store).
  const serve = sirv(renderDir, { dev: true });
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const found = setFile(req.url ?? "");
    if (found === undefined || !renderFinished(found.locale, renderDir)) return next();
    const { url } = req;
    req.url = `/${found.locale}/${found.name}`;
    serve(req, res, () => {
      req.url = url;
      next();
    });
  };
}

export function serveRenderedScreenshots(): Plugin {
  return {
    name: "cloud-speech:store-screenshots",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(renderedScreenshotsHandler());
    },
  };
}
