# 0kay-pm

Fast package manager for the 0KAY platform. Install 0KAY and its plugins with
Node.js 22+ only — **git is not required**. Sources are downloaded as GitHub
`archive` tarballs (branch or release tag) and extracted in-process; each module
additionally needs its Go/Python build toolchain.

## Install the CLI

```powershell
# Standalone repository install (recommended, no git involved)
npm install -g https://codeload.github.com/RazureSOFT/0KAY-pm/tar.gz/main

# Or from a local checkout
npm install -g ./pm

0kay-pm discover
0kay-pm install @razuresoft/0kay-agent
0kay-pm install @razuresoft/0kay
0kay-pm update @razuresoft/0kay-agent
0kay-pm start @razuresoft/0kay
```

`0kay-pm install@razuresoft/0kay` is accepted as well. Once published to npm,
`npx @razuresoft/0kay-pm install @razuresoft/0kay-agent` will work; the package
has not been published yet.

## Releases and versions

Every install downloads the `main` branch by default. Pin a published release
by appending `@version` to the package (or passing `--version`); the release
tag `v<version>` is fetched from GitHub:

```powershell
0kay-pm install @razuresoft/0kay@0.1.0
0kay-pm update @razuresoft/0kay@0.1.0   # pin back to a release
0kay-pm update @razuresoft/0kay          # latest main branch
```

`update` rebuilds the package into a staging directory and swaps it in
atomically; the configured `runtime-env.json` (ports, pairing) is carried over.
Standard component `data` directories are preserved. The previous installation
is retained alongside the new one as an `.old-<id>` recovery copy. Stop the
component before updating; restart it after the update completes.
The installed version comes from the package `manifest.json`.

## Ports

After a successful `install`, 0kay-pm automatically runs the package's manifest
start command. Installing the full platform starts all runnable modules together;
library and UI-only modules are skipped. Services run in the current terminal
with their logs visible; press Ctrl+C to stop them. No browser is opened.
Use `0kay-pm start <package>` to start the installation again later.

Installing `@razuresoft/0kay`, `@razuresoft/0kay-core` or
`@razuresoft/0kay-webui` on an interactive terminal asks for the Core HTTP port
(8080), Core gRPC port (50051) and WebUI port (3000). Answers are written to
`runtime-env.json` and applied by `0kay-pm start`.

Scripts can pass the flags instead — the flags skip the prompts for that port:

```powershell
0kay-pm install @razuresoft/0kay --no-pair --core-port 18080 --webui-port 3300
```

When pairing with a remote Core, connection addresses come from pairing; port
flags then only change the local listeners.

## Discovery and pairing

Every install starts with a UDP LAN scan that refreshes the Core history in
`~/.0kay/state.json`. Choose a Core and confirm pairing, then approve the same
code under Core → Settings → Devices. Without a discovered Core the install
still proceeds; re-install or restart to configure the connection later.
`--no-pair` skips the pairing prompts (the scan still runs).
`--advertise <LAN-IP>` selects the callback interface when detection fails;
cross-subnet discovery depends on your router/firewall.

`--proxy` fetches through `https://gh-proxy.com/https://github.com/...`;
otherwise GitHub is contacted directly.
`--source <local-tree>` installs from a local working tree to test unpublished
manifests. Builds run in a temporary directory and are promoted atomically;
existing installations are never overwritten outside of `update`. Commands come
from the repository manifests — only install from repositories you trust.

## Manifest rules

`manifest.schema=1`; `name`/`version` are required; `install`/`start` are argv
arrays; `modules` lists child manifest paths that are built during install
(child `ui` blocks publish plugin UI bundles too); `dependencies` are package
names; `requires` lists runtime plugin dependencies.
The MCP client gateway and the shared protobuf definitions live in the separate
`RazureSOFT/0KAY-mcp` repository; installing `@razuresoft/0kay-agent` fetches it
as a dependency and arranges the `mcp/` and `proto/` sibling directories.
Optional `ui`: `{ dir?, plugin?, dist?, build? }` — runs `build` in `dir` at the
end of install and atomically publishes `dist` (default `dist`) to
`${CORE_DATA_DIR||data}/plugin-ui/{plugin||package short name}/`.

Commit the manifests in the umbrella and standalone Agent repositories before a
GitHub install can pick up new versions.
The current CLI does not install Node/Go/Python runtimes, does not cross
subnets, does not deploy to the public internet, and does not auto-upgrade
itself.
