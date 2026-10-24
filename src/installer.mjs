// The package-manager surface, re-exported from the modules that actually do
// the work. Kept as one entry point because the CLI and the tests both import
// from here, and because "installer.mjs" is what people grep for.

export {
  packages,
  normalizeRepository,
  resolveSpec,
  packageFolder,
  within,
  archiveUrl,
  selfUpdateTarget,
  validateManifest,
  publishPluginUI,
} from './manifest.mjs'

export {
  downloadArchive,
  verifySourceChecksum,
} from './source.mjs'

export {
  configureToolchains,
  run,
  resolveCommand,
  restrictToUser,
  installPackage,
  uninstallPackage,
} from './install.mjs'

export {
  resolveProxy,
  ProxyTunnelAgent,
  environmentAgent,
  proxyAgentFor,
  downloadOnce,
  latestReleaseTag,
  extractTarGz,
} from './download.mjs'
