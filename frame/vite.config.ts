import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";
import type { Connect, Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

/**
 * Serve the repo's ../data directory at <base>/* during `vite dev` and
 * `vite preview`, so the PWA can read the pipeline's manifest.json,
 * mock-entities.json, and photos/ without a separate file server.
 *
 * This mirrors prod exactly: the frame-uploader add-on writes those files
 * straight into config/www/frame/ (served by HA at /local/frame/), with no
 * data/ subfolder — so this middleware forwards from the same base, not a
 * data/ prefix under it.
 */
function serveData(base: string): Plugin {
  const dataRoot = normalize(join(__dirname, "..", "data"));
  const prefix = base;
  // Only these live under dataRoot; everything else under base is a real
  // built asset (JS bundles, icons, sw.js) and must fall through to Vite.
  const dataPaths = ["manifest.json", "mock-entities.json", "photos/", "thumbs/"];
  const types: Record<string, string> = {
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url || "").split("?")[0];
    if (!url.startsWith(prefix)) return next();
    const rel = url.slice(prefix.length);
    if (!dataPaths.some((p) => rel === p || rel.startsWith(p))) return next();
    // Resolve safely inside dataRoot (block path traversal).
    const abs = normalize(join(dataRoot, decodeURIComponent(rel)));
    if (!abs.startsWith(dataRoot) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("Content-Type", types[extname(abs).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(abs).pipe(res);
  };
  return {
    name: "frame-os-serve-data",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// Served from Home Assistant's /local/frame/ path (config/www/frame/), not
// domain root — every built asset and runtime fetch must be prefixed to match.
const BASE = "/local/frame/";

// https://vite.dev/config/
export default defineConfig({
  base: BASE,
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  // The frame's WebView is ~Chrome 60. The modern build floors at chrome61;
  // the legacy plugin below emits a fully-transpiled nomodule bundle for the
  // real device (Chrome 60 has no <script type=module> support).
  build: {
    target: ["es2015", "chrome61"],
    cssTarget: "chrome61",
  },
  plugins: [
    serveData(BASE),
    legacy({
      targets: ["chrome >= 60"],
      // Polyfill modern JS for the ancient WebView.
      polyfills: true,
      modernPolyfills: true,
      renderLegacyChunks: true,
    }),
  ],
});
