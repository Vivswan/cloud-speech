import { createReadStream, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Plugin } from "vite";
import { RENDER_DIR, STORE_SCREENSHOTS_DIR } from "./screenshot-source";

// Dev-only: serves the local render (apps/extension/.output/store-screenshots/)
// at <base>store-screenshots/<file>, the prefix lib/screenshot-source.ts hands
// the walkthrough page in dev. A file that is not there falls through to
// Astro's 404, so the frame shows the scene's description instead.

/** The set is JPEGs plus crops.json; nothing else is served. */
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

/** The requested file's name when the URL is under the set's directory, else
 *  undefined. Astro's dev server strips the site base from the path before
 *  Vite's middlewares see it, so the bare form is the one that matches; the
 *  based form is accepted too, so the plugin holds if that changes. */
function requestedFile(url: string, base: string): string | undefined {
  const path = url.split("?")[0] ?? "";
  for (const prefix of [`/${STORE_SCREENSHOTS_DIR}/`, `${base}${STORE_SCREENSHOTS_DIR}/`]) {
    if (path.startsWith(prefix)) return decodeURIComponent(path.slice(prefix.length));
  }
  return undefined;
}

export function serveRenderedScreenshots(base: string): Plugin {
  return {
    name: "cloud-speech:store-screenshots",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const name = requestedFile(req.url ?? "", base);
        if (name === undefined) return next();
        const type = CONTENT_TYPES[extname(name)];
        // The set is flat: a name with a path separator or a leading dot is
        // not one of its files, whatever it would resolve to.
        if (!type || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
          return next();
        }
        const file = join(RENDER_DIR, name);
        let size: number;
        try {
          const stats = statSync(file);
          if (!stats.isFile()) return next();
          size = stats.size;
        } catch {
          return next();
        }
        res.setHeader("Content-Type", type);
        res.setHeader("Content-Length", size);
        // A re-render replaces the files in place; a reload must show it.
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(file).pipe(res);
      });
    },
  };
}
