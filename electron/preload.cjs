const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  mtgaArchiveNow: () => ipcRenderer.invoke('mtga-archive-now'),
  mtgaLoadGames: (decks) => ipcRenderer.invoke('mtga-load-games', decks),
  mtgaListArchives: () => ipcRenderer.invoke('mtga-list-archives'),
  mtgaPruneArchives: (days) => ipcRenderer.invoke('mtga-prune-archives', days),
  ocrImage: (dataUrl) => ipcRenderer.invoke('ocr-image', dataUrl),
  openJournalWindow: (deckId) => ipcRenderer.invoke('open-journal-window', deckId),
  notifyDecksChanged: () => ipcRenderer.send('decks-changed'),
  onDecksUpdated: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('decks-updated', listener)
    return () => ipcRenderer.removeListener('decks-updated', listener)
  },
  reloadWindow: () => ipcRenderer.invoke('reload-window'),
  fetchUrl: (url) => ipcRenderer.invoke('fetch-url', url),
  fetchScryfallCards: (url) => ipcRenderer.invoke('fetch-scryfall-cards', url),
  saveDecksBackup: (json) => ipcRenderer.invoke('save-decks-backup', json),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  loadBackup: (filename) => ipcRenderer.invoke('load-backup', filename),
  clearOldBackups: (olderThanDays) => ipcRenderer.invoke('clear-old-backups', olderThanDays),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('update-status', listener)
    return () => ipcRenderer.removeListener('update-status', listener)
  },
})
