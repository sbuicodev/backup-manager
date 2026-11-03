import { describe, expect, test } from 'vitest'
import { defaultConfig, newDestination, newSource, type Settings } from '@shared/schema'
import type { RunStatus, SchedulerStatus } from '@shared/types'
import {
  TOP_BAR_HEIGHT,
  linuxAutostartEntry,
  shouldNotify,
  titleBarOptions,
  titleBarOverlay,
  trayActions,
  trayBackupLines,
  trayStatusLine,
  windowMaterial
} from '../../src/main/os-helpers'

const now = new Date(2026, 9, 26, 10, 0) // Monday
function cfg(): ReturnType<typeof defaultConfig> {
  const c = defaultConfig()
  c.sources.push(
    { ...newSource('/a', 'Documents', []), id: 's1' },
    { ...newSource('/b', 'Photos', ['Documents']), id: 's2' }
  )
  c.destinations.push({ ...newDestination('/n', 'NAS'), id: 'd1' })
  return c
}
const idle = (over: Partial<SchedulerStatus> = {}): SchedulerStatus => ({
  active: null,
  pending: [],
  pausedUntil: null,
  nextRuns: [],
  pendingRetries: [],
  ...over
})

describe('trayStatusLine', () => {
  test('running with a current job', () => {
    const st = idle({
      active: { id: 'r', trigger: 'manual', jobs: [{ sourceId: 's2', destId: 'd1' }] }
    })
    expect(trayStatusLine(st, cfg(), now, { sourceId: 's2', destId: 'd1' })).toBe(
      'Running: Photos → NAS'
    )
    expect(trayStatusLine(st, cfg(), now, null)).toBe('Running…')
  })
  test('paused', () => {
    expect(trayStatusLine(idle({ pausedUntil: 'forever' }), cfg(), now)).toBe('Paused')
    expect(
      trayStatusLine(idle({ pausedUntil: new Date(2026, 9, 26, 15, 30).toISOString() }), cfg(), now)
    ).toBe('Paused until 15:30')
    expect(
      trayStatusLine(idle({ pausedUntil: new Date(2026, 9, 27, 9, 5).toISOString() }), cfg(), now)
    ).toBe('Paused until Tue 09:05')
  })
  test('idle with next run today, later this week, or none', () => {
    const today = idle({
      nextRuns: [
        { sourceId: 's2', at: new Date(2026, 9, 27, 2).toISOString() },
        { sourceId: 's1', at: new Date(2026, 9, 26, 14).toISOString() }
      ]
    })
    expect(trayStatusLine(today, cfg(), now)).toBe('Idle · next: Documents at 14:00')
    const later = idle({
      nextRuns: [{ sourceId: 's2', at: new Date(2026, 9, 27, 2).toISOString() }]
    })
    expect(trayStatusLine(later, cfg(), now)).toBe('Idle · next: Photos at Tue 02:00')
    expect(trayStatusLine(idle({ nextRuns: [{ sourceId: 's1', at: null }] }), cfg(), now)).toBe(
      'Idle · no schedules'
    )
  })
})

test('tray status line mentions pending retries when idle', () => {
  const st = idle({
    nextRuns: [{ sourceId: 's1', at: new Date(2026, 9, 26, 14).toISOString() }],
    pendingRetries: [
      { sourceId: 's1', destId: 'd1', nextRetryAt: null },
      { sourceId: 's2', destId: 'd1', nextRetryAt: null }
    ]
  })
  expect(trayStatusLine(st, cfg(), now)).toBe('Idle · next: Documents at 14:00 · 2 retries pending')
  expect(trayStatusLine({ ...st, pendingRetries: st.pendingRetries.slice(0, 1) }, cfg(), now)).toBe(
    'Idle · next: Documents at 14:00 · 1 retry pending'
  )
  expect(trayStatusLine({ ...st, pausedUntil: 'forever' }, cfg(), now)).toBe('Paused')
})

describe('shouldNotify', () => {
  const table: [Settings['notifications'], RunStatus, boolean][] = [
    ['problems', 'completed', false],
    ['problems', 'completed-with-warnings', true],
    ['problems', 'failed', true],
    ['problems', 'cancelled', false],
    ['always', 'completed', true],
    ['always', 'completed-with-warnings', true],
    ['always', 'failed', true],
    ['always', 'cancelled', true],
    ['never', 'completed', false],
    ['never', 'completed-with-warnings', false],
    ['never', 'failed', false],
    ['never', 'cancelled', false]
  ]
  test.each(table)('%s + %s → %s', (setting, status, expected) => {
    expect(shouldNotify(setting, status)).toBe(expected)
  })
})

test('linuxAutostartEntry', () => {
  expect(linuxAutostartEntry('/opt/Backup Manager/backup-manager')).toBe(
    '[Desktop Entry]\nType=Application\nName=Backup Manager\nExec="/opt/Backup Manager/backup-manager" --hidden\nX-GNOME-Autostart-enabled=true\n'
  )
})

describe('trayActions', () => {
  const idle: SchedulerStatus = {
    active: null,
    pending: [],
    pausedUntil: null,
    nextRuns: [],
    pendingRetries: []
  }
  test('idle: run, pause options', () => {
    expect(trayActions(idle)).toEqual(['run-all', 'pause-hour', 'pause-forever'])
  })
  test('running: cancel comes right after run all', () => {
    const running = { ...idle, active: { id: 'r', trigger: 'manual' as const, jobs: [] } }
    expect(trayActions(running)).toEqual(['run-all', 'cancel', 'pause-hour', 'pause-forever'])
  })
  test('paused: resume instead of pause', () => {
    expect(trayActions({ ...idle, pausedUntil: 'forever' })).toEqual(['run-all', 'resume'])
  })
})

describe('titleBarOptions', () => {
  test('macOS: hidden inset title bar, traffic lights centred in the top bar', () => {
    const o = titleBarOptions('darwin', false)
    expect(o).toMatchObject({ titleBarStyle: 'hiddenInset' })
    expect(o).not.toHaveProperty('titleBarOverlay')
    expect(o.trafficLightPosition!.y * 2 + 12).toBeCloseTo(TOP_BAR_HEIGHT, -1)
  })
  test('Windows and Linux: hidden title bar with native controls in the top bar', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(titleBarOptions(platform, false)).toEqual({
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#fafafa', symbolColor: '#0a0a0a', height: TOP_BAR_HEIGHT }
      })
    }
  })
  test('overlay colours follow the dark theme', () => {
    expect(titleBarOverlay(true)).toEqual({
      color: '#171717',
      symbolColor: '#fafafa',
      height: TOP_BAR_HEIGHT
    })
  })
})

describe('windowMaterial', () => {
  test('glass on: macOS vibrancy, Windows acrylic, nothing native on Linux', () => {
    expect(windowMaterial('darwin', true)).toEqual({ vibrancy: 'under-window' })
    expect(windowMaterial('win32', true)).toEqual({ backgroundMaterial: 'acrylic' })
    expect(windowMaterial('linux', true)).toEqual({})
  })
  test('glass off: no native material anywhere', () => {
    expect(windowMaterial('darwin', false)).toEqual({ vibrancy: null })
    expect(windowMaterial('win32', false)).toEqual({ backgroundMaterial: 'none' })
    expect(windowMaterial('linux', false)).toEqual({})
  })
})

describe('trayBackupLines', () => {
  const at = new Date(2026, 10, 3, 15, 0)
  test('one line per backup, saying how it is doing', () => {
    const c = cfg()
    c.destinations.push({ ...newDestination('/usb', 'USB stick'), id: 'd2' })
    c.sources.push({
      ...newSource('/c', 'Tax', ['Documents', 'Photos']),
      id: 's3',
      setupComplete: false
    })
    c.sources.push({
      ...newSource('/d', 'Old', ['Documents', 'Photos', 'Tax']),
      id: 's4',
      enabled: false
    })
    const results = [
      {
        sourceId: 's1',
        destId: 'd1',
        runId: 'r',
        endedAt: new Date(2026, 10, 3, 13, 0).toISOString(),
        status: 'completed' as const,
        bytesWritten: 0
      }
    ]
    const st = idle({ pendingRetries: [{ sourceId: 's2', destId: 'd2', nextRetryAt: null }] })
    expect(trayBackupLines(c, results, st, at)).toEqual([
      { id: 's1', label: 'Documents — backed up 2 hours ago' },
      { id: 's2', label: 'Photos — waiting for USB stick' },
      { id: 's3', label: 'Tax — not set up' },
      { id: 's4', label: 'Old — paused' }
    ])
  })
})
