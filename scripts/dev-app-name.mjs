// Names the development Electron.app "Backup Manager", so the macOS menu bar and Dock show the
// app's name during `npm run dev` (they read it from the bundle, not from the running code).
// Packaged builds are named by electron-builder and don't need this.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'Backup Manager'
if (process.platform === 'darwin') {
  const plist = join(
    import.meta.dirname,
    '../node_modules/electron/dist/Electron.app/Contents/Info.plist'
  )
  if (existsSync(plist)) {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('plutil', ['-replace', key, '-string', NAME, plist])
    }
  }
}
