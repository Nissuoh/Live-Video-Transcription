import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { argv, cwd } from "node:process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ZipFile } from "yazl";

const root = cwd();
const outDir = join(root, "webstore");
const zipPath = join(outDir, "live-video-translation.zip");
const include = [
  "manifest.json",
  "popup.html",
  "options.html",
  "options.css",
  "dist",
  "icons",
  "_locales",
];

if (argv.includes("--clean") && existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const zip = new ZipFile();
for (const item of include) {
  await addPath(zip, join(root, item));
}
zip.end();

await finished(Readable.from(zip.outputStream).pipe(createWriteStream(zipPath)));
console.log(`Created ${relative(root, zipPath)}`);

async function addPath(zipFile, path) {
  const info = await stat(path);
  const name = relative(root, path).split(sep).join("/");
  if (info.isDirectory()) {
    const children = await readdir(path);
    for (const child of children) {
      await addPath(zipFile, join(path, child));
    }
    return;
  }
  zipFile.addFile(path, name || basename(path));
}
