import { ipcMain } from 'electron'
import type { Handler } from './handlers'

export function registerIpc(handlers: Record<string, Handler>): void {
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => fn(...args))
  }
}
