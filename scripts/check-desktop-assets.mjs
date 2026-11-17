// Check the actual release binary, rather than just the Vite output directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";

const [executableArg, assetsArg, reportPath, depfileArg] =
  process.argv.slice(2);
assert(
  executableArg && assetsArg,
  "Usage: node scripts/check-desktop-assets.mjs <executable> <tauri-codegen-assets-directory> [report.json] [atorch-app.d]",
);
const executable = resolve(executableArg);
const binary = await readFile(executable);
const report = {
  executable,
  executableSha256: createHash("sha256").update(binary).digest("hex"),
  assets: [],
  status: "failed",
};
// Cargo keeps earlier content-addressed assets in OUT_DIR. When a depfile is
// supplied, verify every asset referenced by this build, excluding stale files.
const files = depfileArg
  ? [
      ...new Set(
        [
          ...(await readFile(depfileArg, "utf8")).matchAll(
            /tauri-codegen-assets[\\/]([a-f\d]+\.[a-z]+)(?=\s|$)/g,
          ),
        ].map((match) => match[1]),
      ),
    ].sort()
  : (await readdir(assetsArg)).sort();
if (depfileArg) report.depfile = resolve(depfileArg);
for (const file of files) {
  const compressed = await readFile(join(assetsArg, file));
  const content = brotliDecompressSync(compressed);
  report.assets.push({
    file,
    bytes: content.length,
    compressedBytes: compressed.length,
    executableOffset: binary.indexOf(compressed),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
const missing = report.assets.filter((asset) => asset.executableOffset < 0);
const extensions = new Set(report.assets.map((asset) => extname(asset.file)));
if (
  missing.length === 0 &&
  [".html", ".js", ".css"].every((extension) => extensions.has(extension))
) {
  report.status = "passed";
} else {
  report.error = missing.length
    ? `Frontend assets are missing from the executable: ${missing.map((asset) => asset.file).join(", ")}`
    : "Compiled frontend must include HTML, JavaScript and CSS";
  process.exitCode = 1;
}
if (reportPath)
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
