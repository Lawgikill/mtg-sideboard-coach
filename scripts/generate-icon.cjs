const sharp = require('sharp')
const path = require('path')

const src = path.join(__dirname, '../build/icon.svg')
const dest = path.join(__dirname, '../build/icon.png')

sharp(src)
  .resize(512, 512)
  .png()
  .toFile(dest)
  .then(() => console.log('Icon written to build/icon.png'))
  .catch((err) => { console.error(err); process.exit(1) })
