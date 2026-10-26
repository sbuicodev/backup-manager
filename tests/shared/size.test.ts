import { expect, test } from 'vitest'
import { fromBytes, toBytes } from '../../src/renderer/src/lib/size'

test('toBytes uses binary units', () => {
  expect(toBytes(4095, 'MB')).toBe(4_293_918_720)
  expect(toBytes(2, 'GB')).toBe(2 * 1024 ** 3)
})

test('fromBytes picks GB when whole, else MB', () => {
  expect(fromBytes(2 * 1024 ** 3)).toEqual({ value: 2, unit: 'GB' })
  expect(fromBytes(1536 * 1024 ** 2)).toEqual({ value: 1536, unit: 'MB' })
  expect(fromBytes(1024 ** 2 + 10)).toEqual({ value: 1, unit: 'MB' })
})
