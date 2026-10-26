import { useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { fromBytes, toBytes, type SizeUnit } from '@/lib/size'

const MIN_BYTES = 1024 ** 2

/** A byte size that can be switched off (null): switch + number + MB/GB unit. */
export function SizeInput({
  value,
  onChange,
  offLabel,
  defaultBytes
}: {
  value: number | null
  onChange: (v: number | null) => void
  offLabel: string
  defaultBytes: number
}): React.JSX.Element {
  const shown = fromBytes(value ?? defaultBytes)
  const [unit, setUnit] = useState<SizeUnit>(shown.unit)
  const amount = value === null ? shown.value : Math.round((value / toBytes(1, unit)) * 100) / 100
  const set = (v: number, u: SizeUnit): void => onChange(Math.max(MIN_BYTES, toBytes(v, u)))
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Switch
        checked={value !== null}
        onCheckedChange={(on) => onChange(on ? defaultBytes : null)}
      />
      {value === null ? (
        <span className="text-muted-foreground text-sm">{offLabel}</span>
      ) : (
        <>
          <Input
            type="number"
            min={1}
            className="w-28"
            value={amount}
            step="any"
            onChange={(e) => set(Number(e.target.value) || 1, unit)}
          />
          <Select
            value={unit}
            onValueChange={(u) => {
              setUnit(u as SizeUnit)
              set(amount, u as SizeUnit)
            }}
          >
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MB">MB</SelectItem>
              <SelectItem value="GB">GB</SelectItem>
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  )
}
