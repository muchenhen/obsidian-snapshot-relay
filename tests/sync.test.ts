import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import type { VaultManifest } from "../src/core";

// Exercise the actual plugin commands without requiring the desktop Obsidian app.
const pluginCode = buildSync({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  write: false,
}).outputFiles[0].text;

interface TestPlugin {
  settings: { serverUrl: string; token: string; vaultId: string; excludedPrefixes: string };
  previewRemote(): Promise<void>;
  downloadRemoteSnapshot(): Promise<void>;
  uploadCurrentVault(): Promise<void>;
}

function setup(options: {
  excludedPrefixes?: string;
  configDir?: string;
  accepted?: boolean;
  localPaths?: string[];
  remotePaths?: string[];
  unchangedPaths?: string[];
} = {}) {
  const requests: { url: string; method: string; body?: string }[] = [];
  const writes: string[] = [];
  const removals: string[] = [];
  const folders: string[] = [];
  const notices: string[] = [];
  const confirmations: string[] = [];
  const bytes = new TextEncoder().encode("note").buffer;
  const remote: VaultManifest = {
    schema: 1,
    vaultId: "test-vault",
    snapshotId: "remote-snapshot",
    createdAt: "2026-01-01T00:00:00Z",
    files: (options.remotePaths ?? ["notes/new.md", "ignored/deep/file.md"]).map((path) => ({
      path, size: 4,
      sha256: options.unchangedPaths?.includes(path) ? createHash("sha256").update("note").digest("hex") : "remote-hash",
      mtime: 1,
    })),
  };
  const app = {
    vault: {
      configDir: options.configDir ?? ".obsidian",
      getName: () => "test-vault",
      getFiles: () => (options.localPaths ?? ["notes/old.md", "ignored/local.md"]).map((path) => ({
        path, stat: { mtime: 1 },
      })),
      readBinary: async () => bytes,
      createFolder: async (path: string) => { folders.push(path); },
      adapter: {
        writeBinary: async (path: string) => { writes.push(path); },
        remove: async (path: string) => { removals.push(path); },
      },
    },
  };
  const obsidian = {
    Plugin: class {
      constructor(public app: unknown) {}
    },
    PluginSettingTab: class {},
    Setting: class {},
    Notice: class {
      constructor(message: string) { notices.push(message); }
    },
    Modal: class {
      accepted = false;
      message = "";
      contentEl = { empty() {} };
      onClose() {}
      open() {
        confirmations.push(this.message);
        this.accepted = options.accepted ?? true;
        this.onClose();
      }
    },
    requestUrl: async (request: { url: string; method: string; body?: string }) => {
      requests.push(request);
      const response = request.url.endsWith("/manifest") ? remote : { snapshotId: "uploaded-snapshot" };
      return { text: JSON.stringify(response), arrayBuffer: bytes };
    },
  };
  const module = { exports: {} as { default: new (app: unknown) => TestPlugin } };
  runInNewContext(pluginCode, {
    module,
    exports: module.exports,
    require: (name: string) => {
      assert.equal(name, "obsidian");
      return obsidian;
    },
    crypto: webcrypto,
  });
  const plugin = new module.exports.default(app);
  plugin.settings = {
    serverUrl: "https://relay.example.com",
    token: "test-token",
    vaultId: "test-vault",
    excludedPrefixes: options.excludedPrefixes ?? "ignored/\nsnapshot-relay-backups/",
  };
  return { plugin, requests, writes, removals, folders, notices, confirmations };
}

test("preview excludes remote paths using this device's settings", async () => {
  const state = setup({ localPaths: [] });
  await state.plugin.previewRemote();
  assert.equal(state.notices.length, 1);
  assert.match(state.notices[0], /新增 1，修改 0，删除 0，未变化 0/);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
});

test("download never requests, backs up, overwrites or removes excluded files", async () => {
  const state = setup({
    localPaths: ["notes/old.md", "ignored/local.md", "snapshot-relay-backups/previous/old.md"],
    remotePaths: ["notes/new.md", "ignored/local.md", "ignored/deep/file.md", "snapshot-relay-backups/remote/old.md"],
  });
  await state.plugin.downloadRemoteSnapshot();
  assert.deepEqual(state.requests.map(({ url }) => new URL(url).pathname), [
    "/v1/vaults/test-vault/manifest",
    "/v1/vaults/test-vault/snapshots/remote-snapshot/files/notes/new.md",
  ]);
  assert.equal(state.writes.length, 2);
  assert.match(state.writes[0], /^snapshot-relay-backups\/[^/]+\/notes\/old\.md$/);
  assert.equal(state.writes[1], "notes/new.md");
  assert.deepEqual(state.removals, ["notes/old.md"]);
  assert.ok(state.folders.every((path) => !path.startsWith("ignored")));
  assert.match(state.confirmations[0], /新增 1，修改 0，删除 1，未变化 0/);
  assert.deepEqual(state.notices, ["下载完成：remote-snapshot"]);
});

test("download always protects its own plugin directory, including a custom config directory", async () => {
  const state = setup({
    excludedPrefixes: "",
    configDir: "custom-config",
    localPaths: ["custom-config/plugins/snapshot-relay/data.json"],
    remotePaths: ["custom-config/plugins/snapshot-relay/data.json", "custom-config/plugins/snapshot-relay/main.js", "notes/new.md"],
  });
  await state.plugin.downloadRemoteSnapshot();
  assert.equal(state.requests.length, 2);
  assert.deepEqual(state.writes, ["notes/new.md"]);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.notices, ["下载完成：remote-snapshot"]);
});

test("blank rules still download ordinary files and cancellation makes no changes", async () => {
  const state = setup({ excludedPrefixes: "", localPaths: [] });
  await state.plugin.downloadRemoteSnapshot();
  assert.deepEqual(state.writes, ["notes/new.md", "ignored/deep/file.md"]);

  const cancelled = setup({ accepted: false });
  await cancelled.plugin.downloadRemoteSnapshot();
  assert.equal(cancelled.requests.length, 1);
  assert.deepEqual(cancelled.writes, []);
  assert.deepEqual(cancelled.removals, []);
  assert.deepEqual(cancelled.folders, []);
});

test("upload still publishes only included local files and reports all removed remote files", async () => {
  const state = setup();
  await state.plugin.uploadCurrentVault();
  assert.deepEqual(state.requests.map(({ method }) => method), ["GET", "POST", "PUT", "POST"]);
  const manifest = JSON.parse(state.requests[3].body!) as VaultManifest;
  assert.deepEqual(manifest.files.map(({ path }) => path), ["notes/old.md"]);
  assert.match(state.confirmations[0], /新增 1，修改 0，删除 2，未变化 0/);
  assert.deepEqual(state.notices, ["上传完成：uploaded-snapshot"]);
});

test("download with every file excluded preserves existing local files", async () => {
  const state = setup({
    localPaths: ["ignored/local.md"],
    remotePaths: ["ignored/local.md", "ignored/remote.md"],
  });
  await state.plugin.downloadRemoteSnapshot();
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.folders, []);
  assert.match(state.confirmations[0], /新增 0，修改 0，删除 0，未变化 0/);
  assert.deepEqual(state.notices, ["下载完成：remote-snapshot"]);
});

test("download respects multiple rules with whitespace and preserves similarly named directories", async () => {
  const state = setup({
    excludedPrefixes: "  /ignored/  \r\n\n private.md \r\n",
    localPaths: [],
    remotePaths: ["ignored/file.md", "private.md", "ignored-other/allowed.md"],
  });
  await state.plugin.downloadRemoteSnapshot();
  assert.equal(state.requests.length, 2);
  assert.deepEqual(state.writes, ["ignored-other/allowed.md"]);
  assert.match(state.confirmations[0], /新增 1，修改 0，删除 0，未变化 0/);
  assert.deepEqual(state.notices, ["下载完成：remote-snapshot"]);
});

test("backup directories stay excluded from downloads even when removed from user rules", async () => {
  for (const excludedPrefixes of ["", "ignored/"]) {
    const state = setup({
      excludedPrefixes,
      localPaths: ["notes/old.md", "snapshot-relay-backups/previous/notes/old.md"],
      remotePaths: ["notes/new.md", "snapshot-relay-backups/remote/notes/old.md"],
    });
    await state.plugin.downloadRemoteSnapshot();
    assert.equal(state.requests.length, 2);
    assert.ok(state.requests[1].url.endsWith("/files/notes/new.md"));
    assert.equal(state.writes.length, 2);
    assert.match(state.writes[0], /^snapshot-relay-backups\/[^/]+\/notes\/old\.md$/);
    assert.equal(state.writes[1], "notes/new.md");
    assert.deepEqual(state.removals, ["notes/old.md"]);
    assert.match(state.confirmations[0], /新增 1，修改 0，删除 1，未变化 0/);
    assert.deepEqual(state.notices, ["下载完成：remote-snapshot"]);
  }
});

test("backup directories stay excluded from uploads without excluding similarly named folders", async () => {
  const state = setup({
    excludedPrefixes: "",
    localPaths: ["notes/old.md", "snapshot-relay-backups/previous/old.md", "snapshot-relay-backups-other/note.md"],
    remotePaths: [],
  });
  await state.plugin.uploadCurrentVault();
  const manifest = JSON.parse(state.requests[state.requests.length - 1].body!) as VaultManifest;
  assert.deepEqual(manifest.files.map(({ path }) => path), ["notes/old.md", "snapshot-relay-backups-other/note.md"]);
  assert.deepEqual(state.notices, ["上传完成：uploaded-snapshot"]);
});

test("preview never counts remote backups even with blank user rules", async () => {
  const state = setup({
    excludedPrefixes: "",
    localPaths: [],
    remotePaths: ["notes/new.md", "snapshot-relay-backups/remote/old.md"],
  });
  await state.plugin.previewRemote();
  assert.match(state.notices[0], /新增 1，修改 0，删除 0，未变化 0/);
});

test("repeated unchanged downloads do not create backups or rewrite files", async () => {
  const state = setup({
    localPaths: ["notes/same.md"],
    remotePaths: ["notes/same.md"],
    unchangedPaths: ["notes/same.md"],
  });
  await state.plugin.downloadRemoteSnapshot();
  await state.plugin.downloadRemoteSnapshot();
  assert.equal(state.requests.length, 2);
  assert.ok(state.requests.every(({ url }) => url.endsWith("/manifest")));
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.folders, []);
  assert.ok(state.confirmations.every((message) => /新增 0，修改 0，删除 0，未变化 1/.test(message)));
});

test("downloads back up only changed or deleted local files and fetch only added or changed files", async () => {
  const state = setup({
    localPaths: ["notes/changed.md", "notes/deleted.md", "notes/same.md"],
    remotePaths: ["notes/added.md", "notes/changed.md", "notes/same.md"],
    unchangedPaths: ["notes/same.md"],
  });
  await state.plugin.downloadRemoteSnapshot();
  assert.deepEqual(state.requests.slice(1).map(({ url }) => new URL(url).pathname), [
    "/v1/vaults/test-vault/snapshots/remote-snapshot/files/notes/added.md",
    "/v1/vaults/test-vault/snapshots/remote-snapshot/files/notes/changed.md",
  ]);
  assert.equal(state.writes.length, 4);
  assert.match(state.writes[0], /^snapshot-relay-backups\/[^/]+\/notes\/changed\.md$/);
  assert.match(state.writes[1], /^snapshot-relay-backups\/[^/]+\/notes\/deleted\.md$/);
  assert.deepEqual(state.writes.slice(2), ["notes/added.md", "notes/changed.md"]);
  assert.deepEqual(state.removals, ["notes/deleted.md"]);
  assert.match(state.confirmations[0], /新增 1，修改 1，删除 1，未变化 1/);
  assert.deepEqual(state.notices, ["下载完成：remote-snapshot"]);
});
