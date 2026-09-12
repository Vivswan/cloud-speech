import { createReadStream, existsSync, lstatSync } from "node:fs";
import { extname, join } from "node:path";
import { SITE_LOCALES, type StoreLocale } from "@cloud-speech/constants";
import type { Plugin } from "vite";
import { FALLBACK_LOCALE, RENDER_DIR, STORE_SCREENSHOTS_DIR } from "./screenshot-source";

// Dev-only: serves the local render in the published branch's layout, at the URLs lib/screenshot-source.ts hands
// the walkthrough pages in dev. A missing or unfinished file falls through to Astro's 404, so the page falls back
// exactly as it does against the branch.
//   <base>store-screenshots/<locale>/<file>  -> that locale's set
//   <base>store-screenshots/<file>           -> the English set

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

export interface SetFile {
  /** The request's directory, or the fallback set for a file at the root. */
  locale: StoreLocale;
  name: string;
}

/** Astro's dev server strips the site base before Vite middlewares see the path, so the bare prefix is
 *  the one that matches; the based form is accepted in case that changes. A set is flat: a name with a
 *  separator or a leading dot is not one of its files, whatever it would resolve to. */
export function setFile(url: string, base: string): SetFile | undefined {
  const path = url.split("?")[0] ?? "";
  for (const prefix of [`/${STORE_SCREENSHOTS_DIR}/`, `${base}${STORE_SCREENSHOTS_DIR}/`]) {
    if (!path.startsWith(prefix)) continue;
    const segments = decodeURIComponent(path.slice(prefix.length)).split("/");
    const name = segments.pop() ?? "";
    if (!CONTENT_TYPES[extname(name)] || name.includes("\\") || name.startsWith(".")) return;
    if (segments.length === 0) return { locale: FALLBACK_LOCALE, name };
    if (segments.length > 1) return;
    const locale = SITE_LOCALES.find((candidate) => candidate.storeLocale === segments[0]);
    return locale && { locale: locale.storeLocale, name };
  }
  return undefined;
}

/** crops.json is the renderer's completion marker (removed before the first scene, written last);
 *  without it the set may mix the new render with the previous one. */
export function completeSetFile(
  { locale, name }: SetFile,
  renderDir: string = RENDER_DIR,
): string | undefined {
  if (!existsSync(join(renderDir, locale, "crops.json"))) return undefined;
  return join(renderDir, locale, name);
}

export function serveRenderedScreenshots(base: string): Plugin {
  return {
    name: "cloud-speech:store-screenshots",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const found = setFile(req.url ?? "", base);
        if (found === undefined) return next();
        const file = completeSetFile(found);
        if (file === undefined) return next();
        let size: number;
        try {
          // lstat, not stat: a symlink in the set is not one of its files, wherever it points.
          const stats = lstatSync(file);
          if (!stats.isFile()) return next();
          size = stats.size;
        } catch {
          return next();
        }
        res.setHeader("Content-Type", CONTENT_TYPES[extname(found.name)] ?? "");
        res.setHeader("Content-Length", size);
        // A re-render replaces the files in place; a reload must show it.
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        // An unhandled stream error would take the dev server down. Once headers are out the client
        // expects Content-Length bytes, so a short body is aborted, not ended.
        const stream = createReadStream(file);
        stream.on("error", () => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.removeHeader("Content-Type");
          res.removeHeader("Content-Length");
          res.statusCode = 404;
          res.end();
        });
        res.on("close", () => stream.destroy());
        stream.pipe(res);
      });
    },
  };
}
