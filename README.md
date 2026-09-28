# qlik-engine

A small CLI for Qlik Cloud's Engine API (QIX) and REST API, built on Qlik's official `@qlik/api` package (pinned to 2.15.2). It fills the gaps in the Qlik MCP server.

| Qlik MCP can't | `qe` |
|---|---|
| Change or delete a chart | `get` → edit JSON → `set`, `rm` |
| Add buttons, text & image | `add` |
| Rename an app | `rename` |
| Set the load script and reload | `script-set`, `reload` |

Requires Node 20+ and macOS (credentials are read from the Keychain; see [Other platforms](#other-platforms)).

## Setup

### 1. Install and point at your tenant

```bash
git clone https://github.com/PierreR79/qlik-engine-cli.git
cd qlik-engine-cli
npm ci
cp qlik.config.example.json qlik.config.json   # then set "host"
```

`host` is your tenant without `https://`, for example `mytenant.eu.qlikcloud.com`. The environment variable `QLIK_HOST` overrides the file. `qlik.config.json` is gitignored.

### 2. Create a machine client (OAuth), once per tenant

Use a machine client rather than an API key: a tenant's maximum API key expiry can be as short as 24 hours, and a key then dies mid-session. A machine client's secret does not expire on that clock, and it acts as itself rather than as you with every role you hold.

1. Administration → Integrations → OAuth → **Create new**, type *Web / Machine to machine*.
2. Set **Consent method** to *Trusted* (otherwise `OAUTH-5`).
3. The client is created with `TenantAdmin`. Remove it under Administration → **Manage users** (not on the OAuth page).
4. Add the client as a **member of the space** that holds your apps, with `dataconsumer` + `facilitator`. Without `facilitator` everything works except reading the script (`Access denied`) and reloading (`403 RELOADS-003`). Apps in someone's personal space cannot be reloaded by a bot; use a shared space.

Store the pair in the Keychain, account = tenant host:

```bash
security add-generic-password -U -s qlik-oauth -a <tenant-host> -w "<client_id>:<client_secret>"
```

Copy the two values separately: copying the dialog's field can include the label (`Client ID:…`), which gives `OAUTH-14 Invalid client_id`. Don't use the interactive `-w` prompt; it cuts input at 128 characters.

The tools exchange the secret for a short-lived token on every run. Nothing is written to disk.

**Fallback:** an API key under the Keychain service `qlik-api-key` (same account) is used if no `qlik-oauth` entry exists.

### 3. Verify

```bash
node qe.mjs whoami
node qe.mjs apps
```

## Commands

```
qe whoami
qe apps
qe sheets     <appId>                          # sheets + object IDs
qe get        <appId> <objectId>  > obj.json   # full property tree
qe set        <appId> <objectId> obj.json
qe add        <appId> <sheetId> props.json [col,row,colspan,rowspan]
qe rm         <appId> <objectId>
qe eval       <appId> "Sum(Sales)"
qe script-get <appId>
qe script-set <appId> file.qvs
qe reload     <appId>                          # REST reload queue, polls until done
qe rename     <appId> "New name"
```

Every write (`set`, `add`, `rm`, `script-set`) first saves the previous state in `backups/<appId>/` (gitignored). To undo a change, run `set`/`script-set` with that file.

Two sessions against the same app are two copies of the document, and the last save wins. Don't run `qe set` against an app someone else is editing.

## Analysis scripts

Read-only; they print JSON.

```
node tools/snapshot.mjs     <appId>                    # tables (rows, fields), every master measure's value, dimension cardinality
node tools/integrity.mjs    <appId>                    # sha256 per object, bookmarks, master items, variables, script hash
node tools/master_items.mjs <appId> [--eval '<expr>']  # master item definitions and descriptions; evaluate extra expressions
```

Compare two `integrity.mjs` outputs to see exactly which objects changed; compare `snapshot.mjs` values against control numbers from your data platform.

## Known pitfalls

- **`@qlik/api` caches GET responses.** When polling reload status, pass `{ noCache: true }`, or the status stays at RELOADING.
- **`process.exit()` truncates piped output at 64 KB.** `qe` waits for stdout to drain before exiting.
- **Each run opens its own Engine session** (`identity`). Without it you can land in a stale shared app instance that doesn't see objects just created elsewhere.
- **Node warns about `localStorage` on every run.** The warning is harmless and hidden.
- **`curl` on `/api/v1/users/me` returns 301.** Use `curl -L` when testing a token by hand.

## Tips

- **Buttons:** don't guess the property format. Run `qe get` on an existing button, copy its `qProperty`, and change the label or target before `qe add`.
- **Changing a chart:** `qe get`, edit `qProperty` (for example `qHyperCubeDef.qDimensions[0].qLibraryId`), then `qe set`.
- **Rotating the secret:** `security delete-generic-password -s qlik-oauth -a <host>`, then store the new pair.

## Other platforms

Credentials are read in one place, `keychain()` in `auth.mjs`. On Linux or Windows, replace it with your secret store (for example `secret-tool` or Windows Credential Manager).

## License

MIT
