const esbuild = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = path.resolve(__dirname, "..");

esbuild.build({
    entryPoints: [path.join(projectRoot, "src", "webview", "main.ts")],
    bundle: true,
    outfile: path.join(projectRoot, "media", "main.js"),
    platform: "browser"
}).catch(() => process.exit(1));
