const { app, BrowserWindow, ipcMain, shell } = require('electron')
const https = require('node:https')
const http = require('node:http')
const zlib = require('node:zlib')
const { promisify } = require('node:util')
const mtgaLogs = require('./mtgaLogs.cjs')
const mtgaGames = require('./mtgaGames.cjs')

const gunzip = promisify(zlib.gunzip)
const fs = require('node:fs')
const path = require('node:path')

const BACKUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour between backups

function getBackupDir() {
  return path.join(app.getPath('userData'), 'backups')
}

function ensureBackupDir() {
  const dir = getBackupDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function listBackupFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^decks-[\dT\-]+\.json$/.test(f))
      .sort()
  } catch {
    return []
  }
}

function nodeFetch(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) { reject(new Error('Too many redirects')); return }
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { headers: { Accept: '*/*', 'User-Agent': 'MTG-Sideboard-Coach' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(nodeFetch(res.headers.location, redirectsLeft - 1))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`)); return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

function isGzip(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
}

ipcMain.handle('fetch-url', async (_event, url) => {
  const buf = await nodeFetch(url)
  return (isGzip(buf) ? await gunzip(buf) : buf).toString('utf8')
})

// Scryfall's bulk card file is gzipped JSONL and decompresses to ~200MB — far too
// large to hand across IPC. Decompress and pre-filter to Standard-legal English
// cards here, then send only that (~5k cards) to the renderer.
ipcMain.handle('fetch-scryfall-cards', async (_event, url) => {
  const buf = await nodeFetch(url)
  const text = (isGzip(buf) ? await gunzip(buf) : buf).toString('utf8')

  const cards = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let card
    try {
      card = JSON.parse(line)
    } catch {
      continue
    }
    // This pre-filter has to agree with the renderer's in scryfall.ts. It does not
    // merely narrow the data — the renderer never sees what is dropped here, so a
    // filter loosened there alone changes nothing. Tokens were added to the
    // renderer first and the count did not move by a single card.
    const standardLegal = card.lang === 'en' && card.legalities && card.legalities.standard === 'legal'
    const token = card.layout === 'token' || card.layout === 'double_faced_token'
    if (card.lang === 'en' && (standardLegal || token)) {
      cards.push(card)
    }
  }

  return JSON.stringify(cards)
})

// Native dialogs (confirm/alert) can leave the renderer without keyboard focus
// once dismissed — the window still looks focused and the mouse works, but no
// keystrokes reach the page until something forces a focus change. Re-focusing
// the web contents restores typing.
ipcMain.handle('focus-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    if (win.isMinimized()) win.restore()
    // Clicking off the window and back is what actually clears the stuck state,
    // so reproduce that exactly: focus() alone is not enough, it needs the blur.
    win.blur()
    win.focus()
  }
  event.sender.focus()
})

// Rebuilding the web contents is the one reliable cure for the stuck-focus state
// a native dialog can leave behind — a fresh page always gets keyboard focus.
ipcMain.handle('reload-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) win.focus()
  event.sender.reload()
})

ipcMain.handle('save-decks-backup', (_event, json) => {
  const dir = ensureBackupDir()
  const files = listBackupFiles(dir)
  const latest = files.at(-1)

  if (latest) {
    const latestPath = path.join(dir, latest)
    const stat = fs.statSync(latestPath)
    // Not enough time has passed since last backup
    if (Date.now() - stat.mtimeMs < BACKUP_INTERVAL_MS) return
    // Content hasn't changed since last backup
    if (fs.readFileSync(latestPath, 'utf8') === json) return
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  fs.writeFileSync(path.join(dir, `decks-${timestamp}.json`), json, 'utf8')
})

ipcMain.handle('list-backups', () => {
  const dir = getBackupDir()
  return listBackupFiles(dir)
    .reverse()
    .slice(0, 50)
    .map((filename) => {
      const stat = fs.statSync(path.join(dir, filename))
      return { filename, modifiedAt: stat.mtime.toISOString() }
    })
})

ipcMain.handle('load-backup', (_event, filename) => {
  // Guard against path traversal — only allow our known filename pattern
  if (!/^decks-[\dT\-]+\.json$/.test(filename)) return null
  try {
    return fs.readFileSync(path.join(getBackupDir(), filename), 'utf8')
  } catch {
    return null
  }
})

ipcMain.handle('clear-old-backups', (_event, olderThanDays) => {
  const dir = getBackupDir()
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  let deleted = 0
  for (const file of listBackupFiles(dir)) {
    const filePath = path.join(dir, file)
    try {
      if (fs.statSync(filePath).mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath)
        deleted++
      }
    } catch {}
  }
  return deleted
})

// Tesseract's language data ships with the app so screenshot import works offline —
// without this it would try to download ~5MB from a CDN on first use.
function getTrainedDataDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'traineddata')
    : path.join(__dirname, '..', 'build', 'traineddata')
}

// Spinning up a worker costs a second or two, so keep one alive across imports.
let ocrWorkerPromise = null

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    const { createWorker } = require('tesseract.js')
    const dir = getTrainedDataDir()
    ocrWorkerPromise = createWorker('eng', 1, { langPath: dir, cachePath: dir, gzip: false })
      .catch((error) => {
        ocrWorkerPromise = null
        throw error
      })
  }
  return ocrWorkerPromise
}

// Upscaling the image before OCR was tried and reverted: 3x recovered a card on a
// two-column screenshot but lost two on a single-column one, so it is not a reliable
// win. The column splitting below is what actually fixed accuracy.
// Returns words with their bounding boxes rather than tesseract's own lines: its
// line grouping runs across the whole image and merges side-by-side columns into
// one another. The renderer rebuilds lines from this geometry instead.
ipcMain.handle('ocr-image', async (_event, dataUrl) => {
  const base64 = String(dataUrl).replace(/^data:image\/[a-zA-Z+]+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')

  const worker = await getOcrWorker()
  const result = await worker.recognize(buffer, {}, { blocks: true })

  const words = []
  for (const block of result.data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (!word.text || !word.text.trim()) continue
          words.push({
            text: word.text,
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1,
          })
        }
      }
    }
  }
  return words
})

app.on('before-quit', async () => {
  if (!ocrWorkerPromise) return
  try {
    const worker = await ocrWorkerPromise
    await worker.terminate()
  } catch {
    // Nothing useful to do if the worker never started.
  }
})

// Pop-out Journal windows, keyed by deck so a second request focuses the existing
// one instead of opening a duplicate.
const journalWindows = new Map()

// Each window keeps its own React copy of the decks, so whoever writes to storage
// has to tell the others to re-read it — otherwise the next save from a window
// holding stale state would silently clobber the other's edits.
ipcMain.on('decks-changed', (event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== event.sender) {
      win.webContents.send('decks-updated')
    }
  }
})

ipcMain.handle('open-journal-window', (_event, deckId) => {
  const existing = journalWindows.get(deckId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    title: 'Match Journal',
    width: 900,
    height: 860,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#111417',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // The renderer reads this hash on boot and renders the journal standalone.
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: `journal=${deckId}` })

  journalWindows.set(deckId, win)
  win.on('closed', () => journalWindows.delete(deckId))
})

function createWindow() {
  const window = new BrowserWindow({
    title: 'MTG Sideboard Coach',
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#f7f8f5',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

// Sweeps while the app is open. MTGA only rotates its log on launch, so archiving
// at any point between two launches is enough — no startup task required.
const MTGA_SWEEP_MS = 5 * 60 * 1000

function sweepMtgaLogs() {
  try {
    const result = mtgaLogs.archiveOnce(app)
    for (const entry of result.copied) {
      console.log(`[mtga] archived ${entry.file} (${entry.bytes} bytes)`)
    }
    for (const failure of result.failed) {
      console.warn(`[mtga] could not archive ${failure.file}: ${failure.reason}`)
    }
    const pruned = mtgaLogs.pruneArchives(app)
    if (pruned > 0) console.log(`[mtga] pruned ${pruned} archived log(s) past retention`)
  } catch (error) {
    // Archiving must never prevent the app from starting.
    console.warn('[mtga] sweep failed:', error.message)
  }
}

ipcMain.handle('mtga-archive-now', () => mtgaLogs.archiveOnce(app))
// Parsing happens here rather than in the renderer: it reads archived files and
// MTGA's SQLite card database, neither of which the renderer can touch.
ipcMain.handle('mtga-load-games', (_event, decks) => mtgaGames.loadGames(app, decks || []))
ipcMain.handle('mtga-list-archives', () => mtgaLogs.listArchives(app))
ipcMain.handle('mtga-prune-archives', (_event, days) => mtgaLogs.pruneArchives(app, days))

app.whenReady().then(() => {
  sweepMtgaLogs()
  setInterval(sweepMtgaLogs, MTGA_SWEEP_MS)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
