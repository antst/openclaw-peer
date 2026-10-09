import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function replaceFileAtomic(options) {
  if (!options || typeof options !== "object" || typeof options.filePath !== "string" || typeof options.content !== "string") throw new TypeError("fake security-runtime: expected options object");
  await mkdir(path.dirname(options.filePath), { recursive: true, mode: options.dirMode });
  const temp = path.join(path.dirname(options.filePath), `${options.tempPrefix ?? "tmp"}-${randomUUID()}`);
  await writeFile(temp, options.content, { mode: options.mode });
  await chmod(temp, options.mode);
  await rename(temp, options.filePath);
}
