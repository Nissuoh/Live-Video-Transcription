import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(extensionRoot, "..");
const targetRoot = join(workspaceRoot, "extension-unpacked");
const localBackendUrl = "ws://127.0.0.1:8000/stream";
const localBackendAccessToken = "local-dev-token";
const include = [
  "manifest.json",
  "popup.html",
  "options.html",
  "options.css",
  "dist",
  "icons",
  "_locales",
];

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });

for (const item of include) {
  await cp(join(extensionRoot, item), join(targetRoot, item), { recursive: true });
}

const defaultsPath = join(targetRoot, "dist", "defaults.js");
const defaultsSource = await readFile(defaultsPath, "utf8");
await writeFile(
  defaultsPath,
  defaultsSource.replace(
    'export const DEFAULT_BACKEND_WSS_URL = "";',
    `export const DEFAULT_BACKEND_WSS_URL = "${localBackendUrl}";`,
  ).replace(
    'export const DEFAULT_BACKEND_ACCESS_TOKEN = "";',
    `export const DEFAULT_BACKEND_ACCESS_TOKEN = "${localBackendAccessToken}";`,
  ),
);

const manifestPath = join(targetRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const csp = manifest.content_security_policy.extension_pages;
manifest.content_security_policy.extension_pages = csp.replace(
  "connect-src 'self' wss://*;",
  "connect-src 'self' wss://* ws://127.0.0.1:* ws://localhost:*;",
);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Created ${targetRoot}`);
console.log(`Local backend URL: ${localBackendUrl}`);
console.log(`Local backend access token: ${localBackendAccessToken}`);
