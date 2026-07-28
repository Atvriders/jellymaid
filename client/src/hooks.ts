import { useCallback, useEffect, useRef, useState } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    fn().then((d) => { setData(d); setError(null) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => { reload() }, [reload])
  return { data, error, loading, reload }
}

/** Polls while `active` is true. Used for scan and plan progress; stops the moment work ends. */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, active: boolean) {
  const [data, setData] = useState<T | null>(null)
  const saved = useRef(fn)
  saved.current = fn

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try { const d = await saved.current(); if (!cancelled) setData(d) } catch { /* transient */ }
    }
    void tick()
    if (!active) return () => { cancelled = true }
    const id = setInterval(() => void tick(), intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs, active])

  return data
}
