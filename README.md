# Snapshot Relay

Manual, confirmation-based snapshots for an Obsidian vault backed by a self-hosted relay server.

Snapshot Relay is provider-neutral: it does not depend on Google Drive, Google Cloud, a particular VPS, or a vendor-specific tunnel. The relay only stores versioned vault snapshots; the plugin controls when a snapshot is previewed, uploaded, or downloaded.

## What it does

- Runs as an Obsidian community plugin on desktop and mobile platforms.
- Shows a local/remote manifest diff before upload or download.
- Uploads the current vault as an immutable snapshot.
- Downloads a selected remote snapshot into the current vault.
- Offers optional local backups before a download changes or removes files, disabled by default. When enabled, only affected local files are backed up. Unchanged files are not downloaded again or backed up.
- Uses a bearer token over HTTPS.
- Keeps background synchronization disabled in the current release.
- Excludes the plugin's own settings directory so the relay token is never included in a snapshot.

The current release is an early, working implementation. It favors explicit user actions and recoverable snapshots over background synchronization.

## Repository layout

- src/ — Obsidian plugin source.
- server/ — dependency-free Python relay service.
- tests/ — TypeScript unit tests.
- manifest.json, main.js, styles.css — installable plugin files.

The generated main.js is committed so a user can install a release without setting up Node.js.

## Install the plugin

For a local or development install, copy these three files into the target vault:

    .obsidian/plugins/snapshot-relay/
      main.js
      manifest.json
      styles.css

Enable community plugins in Obsidian, then enable Obsidian Snapshot Relay.

For Android, the vault must be stored in a user-accessible local folder. Close Obsidian before copying the files. After enabling the plugin, configure the same relay URL, Vault ID, and token on each device.

## Configure the relay

The plugin settings contain:

- Server URL — the HTTPS base URL of the relay, for example https://relay.example.com/.
- Access token — a bearer token configured on the server. Never commit or share it publicly.
- Vault ID — a stable namespace such as my-notes-2026. Use the same value on every device for one vault.
- Create local backup before downloading — off by default, including when upgrading from an older version. Enable this per-device setting to save recovery copies of local files that will change or be deleted. The download confirmation shows whether backups are enabled for that download.
- Excluded path prefixes — one vault-relative path prefix per line, for example `attachments/` or `coding/`. Rules apply to uploads, remote previews, and downloads on that device. The plugin directory and `snapshot-relay-backups/` are always excluded, even if the list is empty or customized.

Devices can use different exclusions for the same Vault ID. For example, Android can exclude `coding/` while the desktop uploads that directory. Android will skip those remote files when previewing or downloading; existing local files under an excluded prefix are left untouched, and are not backed up or deleted. Excluding a directory does not remove files already downloaded there. After upgrading, remove those unwanted local files manually if needed.

When local backups are enabled, `snapshot-relay-backups/` contains recovery copies created before a download modifies or deletes local files. With backups disabled, downloads do not create local backup folders or recovery copies. The directory is always excluded from uploads, remote previews, and downloads, so backups already present in a remote snapshot are skipped and local backups are never recursively copied. Repeated downloads of identical files create no new backups. Existing backup folders are left untouched when switching the setting off.

A Vault ID is a relay namespace, not a Google Drive ID or a local filesystem path. Changing it creates a separate remote namespace.

## Run the relay locally

The relay uses only the Python standard library:

    OBSIDIAN_RELAY_TOKEN='replace-me' \
    python3 server/server.py \
      --host 127.0.0.1 \
      --port 8787 \
      --root ./data

The service requires a non-empty token. In production, keep it behind an HTTPS reverse proxy and bind the Python service to localhost or a private interface.

Example deployment templates are provided in server/:

- obsidian-snapshot-relay.service.example for systemd;
- obsidian-snapshot-relay.env.example for the secret environment file;
- Caddyfile.example for an HTTPS reverse proxy.

## API

All routes below except health require:

    Authorization: Bearer <token>

- GET /v1/health
- GET /v1/vaults/{vault}/manifest
- POST /v1/vaults/{vault}/snapshots
- PUT /v1/vaults/{vault}/snapshots/{id}/files/{relative-path}
- POST /v1/vaults/{vault}/snapshots/{id}/complete
- GET /v1/vaults/{vault}/snapshots/{id}/files/{relative-path}

Uploads go to a temporary snapshot directory. The server publishes the snapshot and updates the latest pointer only after the manifest has been completed and every declared file exists.

## Development

Requirements:

- Node.js 20 or newer;
- npm;
- Python 3.9 or newer for the relay and server tests.

Run the checks:

    npm install
    npm test
    npm run typecheck
    npm run build
    python3 -m unittest discover -s server -p 'test_*.py'

The build writes the installable main.js at the repository root.

## Security notes

- Do not commit relay tokens, server environment files, private keys, local Vaults, or .obsidian runtime data.
- Use HTTPS whenever a phone or an untrusted network connects to the relay.
- Treat the bearer token as a password. Rotate it if it is exposed.
- The relay is intentionally small and has no built-in user database, account system, or multi-user authorization model. Put it behind a trusted network boundary and a strong token.
- Review the code and deployment templates before exposing a relay instance to the public internet.

## License

MIT. See LICENSE.
