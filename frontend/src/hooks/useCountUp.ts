import { useEffect, useState } from 'react'

/**
 * A number that climbs from 0 to `target` (ease-out) when `enabled`; otherwise it is simply `target`, with no
 * intermediate frames at all. Used for the percentage in the middle of the donut, so it moves in step with the ring.
 */
export function useCountUp(target: number, enabled: boolean, durationMs = 900): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const started = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / durationMs)
      setValue(target * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, enabled, durationMs])
  return enabled ? value : target
}
