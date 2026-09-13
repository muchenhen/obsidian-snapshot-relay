import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import { diffManifests, FileRecord, formatDiff, normalizePath, VaultManifest } from "./core";

interface SyncSettings {
  serverUrl: string;
  token: string;
  vaultId: string;
  excludedPrefixes: string;
}

const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "https://your-relay-server.example.com",
  token: "",
  vaultId: "",
  excludedPrefixes: "snapshot-relay-backups/",
};

interface ScannedFile {
  record: FileRecord;
  bytes: ArrayBuffer;
}

interface CreateSnapshotResponse {
  snapshotId: string;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isPartialSettings(value: unknown): value is Partial<SyncSettings> {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return ["serverUrl", "token", "vaultId", "excludedPrefixes"].every(
    (key) => item[key] === undefined || typeof item[key] === "string",
  );
}

export default class ObsidianSnapshotRelayPlugin extends Plugin {
  declare settings: SyncSettings;

  async onload() {
    const loaded: unknown = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, isPartialSettings(loaded) ? loaded : {});
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({
      id: "preview-remote-snapshot",
      name: "Preview remote snapshot",
      callback: () => void this.previewRemote(),
    });
    this.addCommand({
      id: "upload-current-vault",
      name: "Upload current vault to relay server",
      callback: () => void this.uploadCurrentVault(),
    });
    this.addCommand({
      id: "download-remote-snapshot",
      name: "Download remote snapshot from relay server",
      callback: () => void this.downloadRemoteSnapshot(),
    });
    this.addRibbonIcon("cloud-upload", "Upload current vault to relay server", () => void this.uploadCurrentVault());
    this.addRibbonIcon("cloud-download", "Download remote snapshot from relay server", () => void this.downloadRemoteSnapshot());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private apiUrl(path: string): string {
    const base = this.settings.serverUrl.trim().replace(/\/+$/, "");
    if (!base || base.includes("your-relay-server")) throw new Error("请先在插件设置中填写服务地址");
    const vaultId = encodeURIComponent(this.settings.vaultId.trim() || this.app.vault.getName());
    return base + "/v1/vaults/" + vaultId + path;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.settings.token.trim()) throw new Error("请先在插件设置中填写访问 Token");
    return Object.assign({ Authorization: "Bearer " + this.settings.token.trim() }, extra);
  }

  private async jsonRequest<T>(path: string, method: string, body?: string): Promise<T> {
    const response = await requestUrl({
      url: this.apiUrl(path),
      method,
      headers: this.headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      body,
    });
    const parsed: unknown = JSON.parse(response.text) as unknown;
    return parsed as T;
  }

  private async getRemoteManifest(): Promise<VaultManifest | null> {
    try {
      return await this.jsonRequest("/manifest", "GET");
    } catch (error) {
      const message = String(error);
      if (message.includes("404") || statusOf(error) === 404) return null;
      throw error;
    }
  }

  private excluded(path: string): boolean {
    const configDir = this.app.vault.configDir.replace(/\/+$/, "");
    if (path.startsWith(configDir + "/plugins/snapshot-relay/")) return true;
    return this.settings.excludedPrefixes
      .split("\n")
      .map((item) => item.trim().replace(/^\/+/, ""))
      .filter(Boolean)
      .some((prefix) => path === prefix || path.startsWith(prefix));
  }

  private async sha256(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  private async scanVault(): Promise<ScannedFile[]> {
    const scanned: ScannedFile[] = [];
    for (const file of this.app.vault.getFiles()) {
      const path = normalizePath(file.path);
      if (this.excluded(path)) continue;
      const bytes = await this.app.vault.readBinary(file);
      scanned.push({
        record: { path, size: bytes.byteLength, sha256: await this.sha256(bytes), mtime: file.stat.mtime },
        bytes,
      });
    }
    scanned.sort((a, b) => a.record.path.localeCompare(b.record.path));
    return scanned;
  }

  private localManifest(files: ScannedFile[]): VaultManifest {
    return {
      schema: 1,
      vaultId: this.settings.vaultId.trim() || this.app.vault.getName(),
      snapshotId: "",
      createdAt: new Date().toISOString(),
      files: files.map((file) => file.record),
    };
  }

  private summary(local: FileRecord[], remote: FileRecord[]): string {
    return formatDiff(diffManifests(local, remote));
  }

  private async previewRemote() {
    try {
      const local = await this.scanVault();
      const remote = await this.getRemoteManifest();
      if (!remote) {
        new Notice("服务端还没有远程快照；当前 Vault 有 " + local.length + " 个文件。");
        return;
      }
      new Notice("远程快照 " + remote.snapshotId + "：本地/远程差异：" + this.summary(local.map((x) => x.record), remote.files));
    } catch (error) {
      new Notice("预览失败：" + String(error));
    }
  }

  private async uploadCurrentVault() {
    try {
      const local = await this.scanVault();
      const remote = await this.getRemoteManifest();
      const diff = remote
        ? diffManifests(remote.files, local.map((x) => x.record))
        : { added: local.map((x) => x.record.path), changed: [], deleted: [], unchanged: 0 };
      const confirmed = await ConfirmModal.ask(
        this.app,
        "上传当前 Vault 到服务端？\n" + formatDiff(diff) + "\n服务端会生成一个新快照。",
      );
      if (!confirmed) return;
      const created = await this.jsonRequest<CreateSnapshotResponse>("/snapshots", "POST");
      const snapshotId = String(created.snapshotId);
      for (const file of local) {
        await requestUrl({
          url: this.apiUrl("/snapshots/" + encodeURIComponent(snapshotId) + "/files/" + this.encodeFilePath(file.record.path)),
          method: "PUT",
          headers: this.headers({ "Content-Type": "application/octet-stream" }),
          body: file.bytes,
        });
      }
      const manifest = Object.assign(this.localManifest(local), { snapshotId });
      await this.jsonRequest("/snapshots/" + encodeURIComponent(snapshotId) + "/complete", "POST", JSON.stringify(manifest));
      new Notice("上传完成：" + snapshotId);
    } catch (error) {
      new Notice("上传失败：" + String(error));
    }
  }

  private encodeFilePath(path: string): string {
    return path.split("/").map((part) => encodeURIComponent(part)).join("/");
  }

  private async downloadRemoteSnapshot() {
    try {
      const remote = await this.getRemoteManifest();
      if (!remote) {
        new Notice("服务端还没有远程快照。");
        return;
      }
      const local = await this.scanVault();
      const diff = diffManifests(local.map((x) => x.record), remote.files);
      const confirmed = await ConfirmModal.ask(
        this.app,
        "用远程快照覆盖当前 Vault？\n" + formatDiff(diff) + "\n本地被覆盖或删除的文件会先备份到 snapshot-relay-backups。",
      );
      if (!confirmed) return;
      await this.backupLocal(local);
      const remotePaths = new Set(remote.files.map((file) => file.path));
      for (const file of local) {
        if (!remotePaths.has(file.record.path)) await this.app.vault.adapter.remove(file.record.path);
      }
      for (const file of remote.files) {
        const response = await requestUrl({
          url: this.apiUrl("/snapshots/" + encodeURIComponent(remote.snapshotId) + "/files/" + this.encodeFilePath(file.path)),
          method: "GET",
          headers: this.headers(),
        });
        await this.ensureParent(file.path);
        await this.app.vault.adapter.writeBinary(file.path, response.arrayBuffer);
      }
      new Notice("下载完成：" + remote.snapshotId);
    } catch (error) {
      new Notice("下载失败：" + String(error));
    }
  }

  private async ensureParent(path: string) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? current + "/" + part : part;
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        if (!String(error).toLowerCase().includes("exist")) throw error;
      }
    }
  }

  private async backupLocal(files: ScannedFile[]) {
    const root = "snapshot-relay-backups/" + new Date().toISOString().replace(/[:.]/g, "-");
    for (const file of files) {
      const target = root + "/" + file.record.path;
      await this.ensureParent(target);
      await this.app.vault.adapter.writeBinary(target, file.bytes);
    }
  }
}

class ConfirmModal extends Modal {
  private accepted = false;
  private resolve!: (value: boolean) => void;

  static ask(app: App, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(app, message, resolve);
      modal.open();
    });
  }

  constructor(app: App, private message: string, resolve: (value: boolean) => void) {
    super(app);
    this.resolve = resolve;
  }

  onOpen() {
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText("取消").onClick(() => this.close()),
    ).addButton((button) =>
      button.setCta().setButtonText("确认").onClick(() => {
        this.accepted = true;
        this.close();
      }),
    );
  }

  onClose() {
    this.resolve(this.accepted);
    this.contentEl.empty();
  }
}

class SyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianSnapshotRelayPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Connection").setHeading();
    new Setting(containerEl)
      .setName("服务地址")
      .setDesc("例如 https://sync.example.com")
      .addText((text) => text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("访问 Token")
      .setDesc("只保存在本地插件设置，不会上传到 Vault 快照")
      .addText((text) => text.setValue(this.plugin.settings.token).onChange(async (value) => {
        this.plugin.settings.token = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("为空时使用当前 Vault 名称")
      .addText((text) => text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
        this.plugin.settings.vaultId = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("排除路径前缀")
      .setDesc("每行一个，例如 snapshot-relay-backups/；插件自己的设置目录始终排除")
      .addTextArea((text) => text.setValue(this.plugin.settings.excludedPrefixes).onChange(async (value) => {
        this.plugin.settings.excludedPrefixes = value;
        await this.plugin.saveSettings();
      }));
    containerEl.createEl("p", { text: "同步是手动的：使用命令面板或左侧云图标执行预览、上传和下载。" });
  }
}
