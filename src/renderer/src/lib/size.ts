export type SizeUnit = 'MB' | 'GB'

const UNIT: Record<SizeUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 }

/** Binary units: 1 MB = 1,048,576 bytes. */
export function toBytes(value: number, unit: SizeUnit): number {
  return Math.round(value * UNIT[unit])
}

export function fromBytes(bytes: number): { value: number; unit: SizeUnit } {
  if (bytes % UNIT.GB === 0) return { value: bytes / UNIT.GB, unit: 'GB' }
  return { value: Math.round(bytes / UNIT.MB), unit: 'MB' }
}
