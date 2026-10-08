export type LogEntry = { type: string; at: string; agentId?: string } & Record<string, unknown>

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|client[_-]?secret)\b(\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
  /\b(sk|pk|rk)[-_](live|test|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, (match, key: unknown, separator: unknown) =>
        typeof key === 'string' && typeof separator === 'string' && /[:=]/.test(separator)
          ? `${key}${separator}[redacted]`
          : '[redacted]',
      ),
    text,
  )
}

export function clip(text: string, max: number): string {
  const clean = redact(text).replace(/\s+/g, ' ').trim()

  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

const GUIDANCE_PATH = /(^|\/)(CLAUDE\.md|AGENTS\.md|SKILL\.md)$|(^|\/)\.claude\/(skills|agents|commands|rules)\/|(^|\/)\.ai\/|(^|\/)\.github\/(workflows|copilot-instructions)/

export function isGuidancePath(path: string): boolean {
  return GUIDANCE_PATH.test(path)
}

export function relativeTo(root: string | undefined, path: string): string {
  if (root === undefined || !path.startsWith(`${root}/`)) {
    return path
  }

  return path.slice(root.length + 1)
}

/**
 * The argument of a tool call that tells a reader what it touched, without the payload.
 */
export function describeCall(tool: string, input: Record<string, unknown>, root?: string): string {
  const pick = (key: string): string | undefined =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined
  const path = pick('file_path') ?? pick('notebook_path') ?? pick('path')

  if (tool === 'Bash') {
    return clip(pick('command') ?? '', 200)
  }

  if (path !== undefined) {
    return relativeTo(root, path)
  }

  return clip(pick('pattern') ?? pick('url') ?? pick('query') ?? pick('skill') ?? pick('description') ?? '', 160)
}

/** A remote URL without the credentials a token-based clone embeds in it. */
export function withoutCredentials(remote: string): string {
  return remote.replace(/\/\/[^@/]+@/, '//')
}

export function toLine(entry: LogEntry): string {
  return `${JSON.stringify(entry)}\n`
}
