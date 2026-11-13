import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cargoBin = resolve(homedir(), ".cargo", "bin");
const env = { ...process.env };
env.ATORCH_NODE = process.execPath;
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
const originalPath = pathKey ? env[pathKey] : "";
if (pathKey) delete env[pathKey];
env[process.platform === "win32" ? "Path" : "PATH"] = [
  dirname(process.execPath),
  ...(existsSync(cargoBin) ? [cargoBin] : []),
  originalPath,
].join(delimiter);
if (process.platform === "win32" && process.argv[2] === "android") {
  const jdk = "C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot";
  if (!env.JAVA_HOME && existsSync(jdk)) env.JAVA_HOME = jdk;
  if (!env.ANDROID_HOME && existsSync("C:/Android/Sdk"))
    env.ANDROID_HOME = "C:/Android/Sdk";
  if (!env.NDK_HOME && env.ANDROID_HOME) {
    const ndk = resolve(env.ANDROID_HOME, "ndk", "28.2.13676358");
    if (existsSync(ndk)) env.NDK_HOME = ndk;
  }
}
const cli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: resolve(root, "apps/app"),
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
