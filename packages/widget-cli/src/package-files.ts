import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

import { readPackageFile } from "@clarkcant/core";

/** The artifact and author audits read the same contained bytes; never follow directory symlinks. */
export function packageFiles(root: string): { path: string; bytes: Buffer }[] {
  const paths: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      if (["dist", "node_modules", ".git"].includes(name)) continue;
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`${relative}: package artifacts do not follow symlinks`);
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else if (stat.isFile()) paths.push(relative);
      else throw new Error(`${relative}: not a regular package file`);
      if (paths.length > 4096) throw new Error("a package artifact may contain at most 4096 files");
    }
  };
  visit(root, "");
  return paths.sort().map((path) => {
    const file = readPackageFile({ entry: { source: { kind: "local", path: root } }, relativePath: path });
    if (!file.ok) throw new Error(`${path}: ${file.message}`);
    return { path, bytes: file.bytes };
  });
}
