import fs from 'node:fs'
import path from 'node:path'

// What the user typed, turned into something installable.
//
// The ambiguity: `@scope/name` is a package, `/srv/checkout` is a directory, and
// `owner/repo` is a GitHub shorthand. Splitting on the last `@` handled versions
// and nothing else, so `0kay-pm install @D:/0KAY` looked up a package named
// "@D:/0KAY" and failed at the network step with no hint about why.
//
// The rule now: a leading `@` means "the rest is a path" (that is the whole point
// of the prefix — a scoped name never starts with `@/`, `@.` or a drive letter),
// and a bare argument is a path when it names a directory that exists.

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\/

/** Does this look like a filesystem path rather than a package name? */
export function looksLikePath(value, exists = fs.existsSync) {
  if (!value) return false
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('~')) return true
  if (WINDOWS_ABSOLUTE.test(value) || UNC.test(value)) return true
  // A backslash anywhere is a Windows path; scoped names only use forward slashes.
  if (value.includes('\\')) return true
  // Last resort: something that actually exists on disk wins over the network.
  try {
    return exists(value) && fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string | undefined} raw
 * @param {{ versionFlag?: string | null, exists?: (candidate: string) => boolean, cwd?: string }} [options]
 * @returns {{ name: string | null, version: string | null, source?: string }}
 */
export function parseTarget(raw, options = {}) {
  const { versionFlag = null, exists = fs.existsSync, cwd = process.cwd() } = options
  const value = (raw || '').trim()
  if (!value || value.startsWith('-')) return { name: value || null, version: versionFlag }

  // `@<path>`: the @ is a marker, not part of the path.
  if (value.startsWith('@') && looksLikePath(value.slice(1), exists)) {
    return { name: null, version: null, source: path.resolve(cwd, value.slice(1)) }
  }

  // A bare path that exists on disk. Without this, `install /srv/checkout` was
  // read as the GitHub shorthand "owner/repo".
  if (!value.startsWith('@') && looksLikePath(value, exists)) {
    return { name: null, version: null, source: path.resolve(cwd, value) }
  }

  const at = value.lastIndexOf('@')
  const name = at > 0 ? value.slice(0, at) : value
  const version = at > 0 ? value.slice(at + 1) : versionFlag
  return { name, version: version ? version.replace(/^v/, '') : null }
}

/** Read the name out of a local tree so the record and the folder agree. */
export function readLocalName(source) {
  const manifest = path.join(source, 'manifest.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  } catch (error) {
    throw new Error(`No manifest.json in ${source} (${error?.code || error?.message}); pass the repository root, not a subdirectory`)
  }
  if (!parsed?.name) throw new Error(`manifest.json in ${source} has no name`)
  return String(parsed.name)
}
