import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";
import type { Connect, Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

/**
 * Serve the repo's ../data directory at /data/* during `vite dev` and
 * `vite preview`, so the PWA can read the pipeline's manifest.json,
 * mock-entities.json, and photos/ without a separate file server.
 *
 * On the real frame this path is served by whatever hosts the build; in dev we
 * fake it here.
 */
function serveData(base: string): Plugin {
  const dataRoot = normalize(join(__dirname, "..", "data"));
  const prefix = `${base}data/`;
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
    // Resolve safely inside dataRoot (block path traversal).
    const rel = decodeURIComponent(url.slice(prefix.length));
    const abs = normalize(join(dataRoot, rel));
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
