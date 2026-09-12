export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
  mtime: number;
}

export interface VaultManifest {
  schema: 1;
  vaultId: string;
  snapshotId: string;
  createdAt: string;
  files: FileRecord[];
}

export interface DiffSummary {
  added: string[];
  changed: string[];
  deleted: string[];
  unchanged: number;
}

export function normalizePath(path: string): string {
  if (/^[\\/]/.test(path)) throw new Error("invalid relative path");
  const value = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new Error("invalid relative path");
  }
  return parts.join("/");
}

export function diffManifests(local: FileRecord[], remote: FileRecord[]): DiffSummary {
  const left = new Map(local.map((file) => [file.path, file]));
  const right = new Map(remote.map((file) => [file.path, file]));
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;
  for (const [path, remoteFile] of right) {
    const localFile = left.get(path);
    if (!localFile) added.push(path);
    else if (localFile.sha256 !== remoteFile.sha256 || localFile.size !== remoteFile.size) changed.push(path);
    else unchanged++;
  }
  for (const path of left.keys()) {
    if (!right.has(path)) deleted.push(path);
  }
  added.sort();
  changed.sort();
  deleted.sort();
  return { added, changed, deleted, unchanged };
}

export function formatDiff(diff: DiffSummary): string {
  return [
    "新增 " + diff.added.length,
    "修改 " + diff.changed.length,
    "删除 " + diff.deleted.length,
    "未变化 " + diff.unchanged,
  ].join("，");
}
