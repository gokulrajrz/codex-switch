/* c8 ignore file */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { AuthData } from '../types'

interface CodexAuthSyncDeps {
  now?: () => number
}

export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

export function requireNonEmptyString(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`Cannot build Codex auth payload: missing ${fieldName}`)
  }
  if (!value.trim()) {
    throw new Error(`Cannot build Codex auth payload: missing ${fieldName}`)
  }
  return value
}

export function buildCodexAuthJson(authData: AuthData): string {
  const authJson = authData.authJson
  if (isObjectRecord(authJson)) {
    const payload = JSON.parse(JSON.stringify(authJson))
    return `${JSON.stringify(payload, null, 2)}\n`
  }

  const idToken = requireNonEmptyString(authData.idToken, 'idToken')
  const accessToken = requireNonEmptyString(authData.accessToken, 'accessToken')
  const refreshToken = requireNonEmptyString(
    authData.refreshToken,
    'refreshToken',
  )

  const tokens: Record<string, string> = {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
  }

  if (typeof authData.accountId === 'string') {
    if (authData.accountId.trim()) {
      tokens.account_id = authData.accountId
    }
  }

  return `${JSON.stringify({ tokens }, null, 2)}\n`
}

export function syncCodexAuthFile(
  authPath: string,
  authData: AuthData,
  deps: CodexAuthSyncDeps = {},
) {
  syncCodexAuthContent(authPath, buildCodexAuthJson(authData), deps)
}

/** Publishes exact auth contents, including unsupported modes, for rollback. */
export function syncCodexAuthContent(
  authPath: string,
  content: string,
  deps: CodexAuthSyncDeps = {},
): void {
  const dir = path.dirname(authPath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let now = Date.now
  if (deps.now) {
    now = deps.now
  }

  const tmpPath = path.join(
    dir,
    `auth.json.tmp.${process.pid}.${now()}.${randomUUID()}`,
  )

  fs.writeFileSync(tmpPath, content, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })

  // Best-effort atomic replace:
  // - POSIX: rename overwrites.
  // - Windows: rename over an existing file may fail, so fall back to copy+replace.
  try {
    try {
      fs.renameSync(tmpPath, authPath)
      return
    } catch (error) {
      if (process.platform !== 'win32') {
        throw error
      }
      // Windows fallback only; never weaken POSIX replacement guarantees.
      fs.copyFileSync(tmpPath, authPath)
      fs.chmodSync(authPath, 0o600)
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath)
      }
    } catch {
      // ignore
    }
  }
}
