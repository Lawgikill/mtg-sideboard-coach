// Self-updating from GitHub Releases, through electron-updater.
//
// The source of truth is a **Release**, not a commit: the app downloads the release's
// `latest.yml` and the installer it names. Pushing code changes nothing for anyone
// running the app until a release is published with the built installer attached.
//
// Only an installed (NSIS) build can update itself — a portable exe has no install
// location to replace — which is why the portable target was dropped.

const { app, BrowserWindow, ipcMain } = require('electron')

// Startup is busy enough (window, MTGA log sweep); the check can wait a few seconds.
const FIRST_CHECK_DELAY_MS = 10 * 1000
// The app is often left open for a whole session, so check again periodically.
const RECHECK_MS = 4 * 60 * 60 * 1000

// Test hook: point the updater at a local folder served over HTTP instead of GitHub,
// so a full download-install-relaunch can be exercised without publishing anything.
// Unset in normal use.
const FEED_OVERRIDE = process.env.MTG_COACH_UPDATE_FEED

let updater = null
// The last state, kept so a window that opens later can ask instead of waiting for
// the next event.
let status = { state: 'idle' }

function snapshot() {
  return { ...status, currentVersion: app.getVersion() }
}

function publish(next) {
  status = next
  const payload = snapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update-status', payload)
  }
}

async function check() {
  if (!updater) return snapshot()
  // Already fetching, or already have it: a second check would only restart the work.
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') {
    return snapshot()
  }
  try {
    await updater.checkForUpdates()
  } catch (error) {
    publish({ state: 'error', message: error && error.message ? error.message : String(error) })
  }
  return snapshot()
}

function install() {
  if (!updater || status.state !== 'ready') return false
  // Silent install, then relaunch into the new version. Deferred a tick so the IPC
  // reply reaches the renderer before every window starts closing.
  setImmediate(() => updater.quitAndInstall(true, true))
  return true
}

function setup() {
  ipcMain.handle('get-update-status', () => snapshot())
  ipcMain.handle('check-for-updates', () => check())
  ipcMain.handle('install-update', () => install())

  // A dev run has no installed copy to replace and no app-update.yml to read, and
  // electron-updater would throw looking for one.
  if (!app.isPackaged && !FEED_OVERRIDE) {
    status = { state: 'unsupported' }
    return
  }

  const { autoUpdater } = require('electron-updater')
  updater = autoUpdater
  autoUpdater.autoDownload = true
  // An update nobody restarts for still lands: it installs on the next normal quit.
  autoUpdater.autoInstallOnAppQuit = true
  if (FEED_OVERRIDE) autoUpdater.setFeedURL({ provider: 'generic', url: FEED_OVERRIDE })

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => publish({ state: 'current' }))
  autoUpdater.on('update-available', (info) => publish({ state: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => publish({
    state: 'downloading',
    version: status.version,
    percent: Math.round(progress.percent || 0),
  }))
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (error) => publish({
    state: 'error',
    message: error && error.message ? error.message : String(error),
  }))

  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, RECHECK_MS)
}

module.exports = { setup }
