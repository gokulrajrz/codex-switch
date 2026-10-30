import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  readlinkSync,
} from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { randomUUID, createHash } from 'crypto'
import { setTimeout as delay } from 'timers/promises'

const unknownNamespace = randomUUID()

/** PID probes are meaningful only within the same host and PID namespace. */
export function getLockHostId(): string {
  let namespace = 'native'
  if (process.platform === 'linux') {
    try {
      namespace = readlinkSync('/proc/self/ns/pid')
    } catch {
      namespace = unknownNamespace
    }
  }
  return createHash('sha256')
    .update(`${hostname()}:${namespace}`)
    .digest('hex')
    .slice(0, 16)
}

interface ProfilesFileLockDeps {
  now?: () => number
  timeoutMs?: number
  isProcessAlive?: (pid: number) => boolean
}

/** Permission errors are treated as alive: uncertainty must never steal a lock. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code !== 'ESRCH'
  }
}

/**
 * Lamport's bakery mutex over unique, process-owned ticket files. A paused live
 * process retains its ticket; only demonstrably dead owners can be removed.
 * Removing a dead ticket cannot remove a successor's uniquely named ticket.
 * The directory persists and contains no credentials. Participants must share
 * a coherent filesystem; a foreign-host owner fails closed rather than guessing
 * whether its PID is dead. Waits are bounded so callers can report contention.
 */
export async function withProfilesFileLock<T>(
  profilesPath: string,
  action: () => Promise<T>,
  deps: ProfilesFileLockDeps = {},
): Promise<T> {
  const now = deps.now ?? Date.now
  const alive = deps.isProcessAlive ?? isProcessAlive
  const root = `${profilesPath}.lock`
  const host = getLockHostId()
  const owner = `${host}.${process.pid}.${randomUUID()}`
  const ticketPath = join(root, owner)
  const started = Date.now()
  // Older versions used a single file. Reclaim only a dead/old malformed owner,
  // never a live process on the basis of elapsed wall-clock time.
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch (error) {
    try {
      if (!statSync(root).isFile()) {
        throw error
      }
    } catch {
      throw error
    }
    let legacy: { pid?: number } = {}
    try {
      legacy = JSON.parse(readFileSync(root, 'utf8'))
    } catch {
      /* malformed legacy lock */
    }
    if (
      legacy.pid ? alive(legacy.pid) : now() - statSync(root).mtimeMs < 30_000
    ) {
      throw Object.assign(
        new Error(
          'A previous Codex Switch process holds the profile lock. Close it and retry.',
        ),
        { cause: error },
      )
    }
    try {
      unlinkSync(root)
    } catch (cause) {
      if (
        (cause as { code?: string }).code !== 'ENOENT' &&
        (cause as { code?: string }).code !== 'EISDIR'
      ) {
        throw cause
      }
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  const readTicket = (name: string): number | null => {
    try {
      const value: unknown = JSON.parse(readFileSync(join(root, name), 'utf8'))
      return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0
        ? value
        : 0
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null
      }
      if (error instanceof SyntaxError) {
        return 0
      }
      throw error
    }
  }
  const participants = () =>
    readdirSync(root).filter((name) =>
      /^[a-f0-9]{16}\.\d+\.[a-f0-9-]+$/.test(name),
    )
  // Exclusive publication of the choosing flag must precede scanning tickets.
  writeFileSync(ticketPath, '0', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    let number = 1
    for (const name of participants()) {
      number = Math.max(number, (readTicket(name) ?? 0) + 1)
    }
    if (!Number.isSafeInteger(number)) {
      throw new Error('Profile lock ticket overflow.')
    }
    const readyPath = `${ticketPath}.ready`
    try {
      writeFileSync(readyPath, String(number), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      renameSync(readyPath, ticketPath)
    } finally {
      try {
        unlinkSync(readyPath)
      } catch {
        /* already published */
      }
    }
    for (;;) {
      let blocked = false
      for (const name of participants()) {
        if (name === owner) {
          continue
        }
        const [otherHost, pid] = name.split('.')
        if (otherHost === host && !alive(Number(pid))) {
          try {
            unlinkSync(join(root, name))
          } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') {
              throw error
            }
          }
          continue
        }
        const otherNumber = readTicket(name)
        if (
          otherNumber !== null &&
          (otherNumber === 0 ||
            otherNumber < number ||
            (otherNumber === number && name < owner))
        ) {
          blocked = true
        }
      }
      if (!blocked) {
        return await action()
      }
      if (Date.now() - started >= (deps.timeoutMs ?? 60_000)) {
        throw new Error(
          'Timed out waiting for the profile lock. Close other Codex Switch windows and retry.',
        )
      }
      await delay(25)
    }
  } finally {
    try {
      unlinkSync(ticketPath)
    } catch {
      /* A failed cleanup blocks rather than admitting overlapping writers. */
    }
  }
}
