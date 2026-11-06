// Builds the web app into api/public: bundles src/main.js (and the shared rules) with esbuild,
// copies static files, and stamps a version into index.html and the service worker.
import * as esbuild from "esbuild";
import { cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const out = new URL("../api/public/", import.meta.url).pathname;
const watch = process.argv.includes("--watch");

async function finish() {
  const js = await readFile(out + "assets/app.js");
  const css = await readFile(new URL("static/app.css", import.meta.url));
  const v = createHash("sha256").update(js).update(css).digest("hex").slice(0, 10);
  await cp(new URL("static/", import.meta.url), out, { recursive: true });
  for (const f of ["index.html", "sw.js"]) {
    const s = await readFile(out + f, "utf8");
    await writeFile(out + f, s.replaceAll("__VERSION__", v));
  }
  console.log(`Built web app ${v}`);
}

await rm(out, { recursive: true, force: true });
await mkdir(out + "assets", { recursive: true });
const ctx = await esbuild.context({
  entryPoints: [new URL("src/main.js", import.meta.url).pathname],
  bundle: true, format: "esm", target: "es2020", minify: !watch, sourcemap: watch ? "inline" : false,
  outfile: out + "assets/app.js", legalComments: "none",
  plugins: [{ name: "finish", setup(b) { b.onEnd(async (r) => { if (!r.errors.length) await finish(); }); } }],
});
if (watch) await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
