import assert from "node:assert/strict";
import test from "node:test";
import { diffManifests, normalizePath } from "../src/core";

test("normalizes vault relative paths and rejects traversal", () => {
  assert.equal(normalizePath("notes/今天.md"), "notes/今天.md");
  assert.throws(() => normalizePath("../secret.txt"), /invalid relative path/);
  assert.throws(() => normalizePath("/absolute.txt"), /invalid relative path/);
});

test("diffs local and remote manifests by content hash", () => {
  const local = [
    { path: "same.md", size: 1, sha256: "a", mtime: 1 },
    { path: "changed.md", size: 1, sha256: "old", mtime: 1 },
    { path: "deleted.md", size: 1, sha256: "d", mtime: 1 },
  ];
  const remote = [
    { path: "same.md", size: 1, sha256: "a", mtime: 2 },
    { path: "changed.md", size: 2, sha256: "new", mtime: 2 },
    { path: "added.md", size: 1, sha256: "n", mtime: 2 },
  ];
  assert.deepEqual(diffManifests(local, remote), {
    added: ["added.md"],
    changed: ["changed.md"],
    deleted: ["deleted.md"],
    unchanged: 1,
  });
});
