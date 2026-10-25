import { readFile, writeFile } from 'node:fs/promises'
import { defaultConfig, validateConfig, type Config } from '@shared/schema'
import { atomicWriteText } from './fsutil'

export type LoadResult =
  { ok: true; config: Config; created: boolean } | { ok: false; errors: string[] }

export { defaultConfig }

export async function loadConfig(file: string): Promise<LoadResult> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    const config = defaultConfig()
    await writeFile(file, JSON.stringify(config, null, 2), { flag: 'wx' })
    return { ok: true, config, created: true }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`(root): invalid JSON: ${(err as Error).message}`] }
  }
  const r = validateConfig(json)
  return r.ok ? { ok: true, config: r.config, created: false } : r
}

export async function saveConfig(
  file: string,
  config: Config
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const r = validateConfig(config)
  if (!r.ok) return r
  await atomicWriteText(file, JSON.stringify(r.config, null, 2))
  return { ok: true }
}
