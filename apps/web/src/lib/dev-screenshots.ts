import { createReadStream, existsSync, lstatSync } from "node:fs";
import { extname, join } from "node:path";
import { SITE_LOCALES, type StoreLocale } from "@cloud-speech/constants";
import type { Plugin } from "vite";
import { FALLBACK_LOCALE, RENDER_DIR, STORE_SCREENSHOTS_DIR } from "./screenshot-source";

// Dev-only: serves the local render (apps/extension/.output/store-screenshots/)
// at <base>store-screenshots/<locale>/<file>, the prefix lib/screenshot-source.ts
// hands the walkthrough pages in dev, and the fallback set at
// <base>store-screenshots/<file>, the layout of the published branch (its root
// holds the English set as well). A file that is not there, or that belongs
// to a set whose render did not finish, falls through to Astro's 404, so the
// page falls back the way it does against the branch.

/** A set is JPEGs plus crops.json; nothing else is served. */
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

/** One of the sets' files, as a request names it. */
export interface SetFile {
  /** The set: the request's directory, or the fallback set for a file at
   *  the root. */
  locale: StoreLocale;
  /** The file's name inside the set. */
  name: string;
}

/** The set file a request URL names, or undefined when the URL is not under
 *  the sets' directory or does not name one of their files: a set is flat, so
 *  a name with a path separator or a leading dot is not one of its files,
 *  whatever it would resolve to, and a directory that is not a store locale is
 *  not a set. Astro's dev server strips the site base from the path before
 *  Vite's middlewares see it, so the bare form is the one that matches; the
 *  based form is accepted too, so the plugin holds if that changes. */
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

/** The path of a set file under `renderDir`, or undefined when its set has no
 *  completion marker: the renderer removes a set's crops.json before its first
 *  scene and writes it last, so a set without one is mid-render or failed
 *  part-way, and its files could mix the new render with the previous one. */
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
          // lstat: a symlink in the set is not one of its files, wherever it
          // points, so it is not followed.
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
        // A file that stats but cannot be read (unreadable, or gone since the
        // stat) is a 404 for this request; an unhandled stream error would
        // take the dev server down with it. Once headers are out, the client
        // expects Content-Length bytes, so a short response is aborted rather
        // than ended.
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
