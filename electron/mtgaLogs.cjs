const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// MTGA rotates Player.log -> Player-prev.log on every *launch*, keeping only one
// previous session. A 62MB log holding ~30 games was already lost that way. So the
// archiver copies both files: archiving the previous one too buys a one-launch
// buffer, meaning a session survives even if the app is not opened between runs.
const MTGA_LOG_DIR = path.join(
  process.env.USERPROFILE || '',
  'AppData', 'LocalLow', 'Wizards Of The Coast', 'MTGA',
)
const SOURCE_LOGS = ['Player.log', 'Player-prev.log']

const DEFAULT_RETENTION_DAYS = 7
const FINGERPRINT_BYTES = 4096

function getArchiveDir(app) {
  const dir = path.join(app.getPath('userData'), 'mtga-logs')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// A growing log would hash differently on every sweep, producing a pile of
// near-duplicate copies. Fingerprinting the *head* of the file instead stays stable
// as MTGA appends, so one archive per MTGA session gets refreshed in place.
function sessionFingerprint(filePath) {
  let handle
  try {
    handle = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(FINGERPRINT_BYTES)
    const read = fs.readSync(handle, buffer, 0, FINGERPRINT_BYTES, 0)
    if (read === 0) return null
    return crypto.createHash('sha1').update(buffer.subarray(0, read)).digest('hex').slice(0, 12)
  } catch {
    return null
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle) } catch { /* already gone */ }
    }
  }
}

function archiveOnce(app) {
  const archiveDir = getArchiveDir(app)
  const result = { copied: [], unchanged: [], failed: [] }

  for (const name of SOURCE_LOGS) {
    const source = path.join(MTGA_LOG_DIR, name)
    if (!fs.existsSync(source)) continue

    const fingerprint = sessionFingerprint(source)
    if (!fingerprint) continue

    const target = path.join(archiveDir, `mtga-${fingerprint}.log`)

    try {
      const sourceSize = fs.statSync(source).size
      // The live log only grows, so an identical size means nothing new to capture.
      if (fs.existsSync(target) && fs.statSync(target).size === sourceSize) {
        result.unchanged.push(path.basename(target))
        continue
      }

      // MTGA keeps the live log open; Windows allows the read, but a failure here
      // must never take down the sweep for the other file.
      fs.copyFileSync(source, target)
      result.copied.push({ file: path.basename(target), bytes: sourceSize })
    } catch (error) {
      result.failed.push({ file: name, reason: error.message })
    }
  }

  return result
}

function listArchives(app) {
  const archiveDir = getArchiveDir(app)
  try {
    return fs.readdirSync(archiveDir)
      .filter((name) => /^mtga-[0-9a-f]+\.log$/.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(archiveDir, name))
        return { filename: name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

// Only the raw logs age out. Anything parsed out of them is stored separately and
// kept, so history does not disappear when its bulky source does.
function pruneArchives(app, retentionDays = DEFAULT_RETENTION_DAYS) {
  const archiveDir = getArchiveDir(app)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let deleted = 0

  for (const entry of listArchives(app)) {
    const filePath = path.join(archiveDir, entry.filename)
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
        deleted += 1
      }
    } catch { /* already gone */ }
  }

  return deleted
}

module.exports = {
  MTGA_LOG_DIR,
  DEFAULT_RETENTION_DAYS,
  getArchiveDir,
  archiveOnce,
  listArchives,
  pruneArchives,
}
