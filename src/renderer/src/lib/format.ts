const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function fmtBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let i = 0
  let n = bytes
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  const d = n >= 100 || i === 0 ? 0 : digits
  return `${n.toFixed(d)} ${UNITS[i]}`
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtDate(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** `C:\Users\Alex\AppData` -> `~\AppData` relative to the profile, else strip the drive. */
export function prettyPath(p: string, root: string): string {
  const home = p.match(/^[a-z]:\\users\\[^\\]+/i)?.[0]
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) {
    return '~' + p.slice(home.length)
  }
  if (p.toLowerCase().startsWith(root.toLowerCase())) {
    return p.slice(root.replace(/\\+$/, '').length) || p
  }
  return p
}

export function baseName(p: string): string {
  const t = p.replace(/\\+$/, '')
  return t.slice(t.lastIndexOf('\\') + 1) || t
}
