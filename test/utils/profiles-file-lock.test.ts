import { spawn } from 'node:child_process'
/** Tests for profiles-file-lock. */
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { setTimeout as delay } from 'timers/promises'
import {
  withProfilesFileLock,
  isProcessAlive,
  getLockHostId,
} from '../../src/utils/profiles-file-lock'

test('withProfilesFileLock serializes concurrent mutations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-lock-'))
  const profilesPath = path.join(dir, 'profiles.json')
  const order: string[] = []
  let releaseFirst!: () => void

  const first = withProfilesFileLock(profilesPath, async () => {
    order.push('first-start')
    await new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    order.push('first-end')
  })

  const second = withProfilesFileLock(profilesPath, async () => {
    order.push('second')
  })

  while (order.length === 0) {
    await delay(10)
  }

  await delay(150)
  assert.deepEqual(order, ['first-start'])

  releaseFirst()
  await first
  await second

  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
  assert.deepEqual(fs.readdirSync(`${profilesPath}.lock`), [])
})

test('withProfilesFileLock clears stale lock files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-lock-'))
  const profilesPath = path.join(dir, 'profiles.json')
  const lockPath = `${profilesPath}.lock`

  fs.writeFileSync(lockPath, 'broken-lock', 'utf8')
  const staleTime = new Date('2000-01-01T00:00:00.000Z')
  fs.utimesSync(lockPath, staleTime, staleTime)

  let ran = false
  await withProfilesFileLock(profilesPath, async () => {
    ran = true
    assert.equal(fs.existsSync(lockPath), true)
  })

  assert.equal(ran, true)
  assert.deepEqual(fs.readdirSync(lockPath), [])
})

test('withProfilesFileLock uses injected clock for stale lock detection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-lock-'))
  const profilesPath = path.join(dir, 'profiles.json')
  const lockPath = `${profilesPath}.lock`

  fs.writeFileSync(lockPath, 'broken-lock', 'utf8')

  let ran = false
  await withProfilesFileLock(
    profilesPath,
    async () => {
      ran = true
      assert.equal(fs.existsSync(lockPath), true)
    },
    {
      now: () => new Date('2100-01-01T00:00:00.000Z').getTime(),
    },
  )

  assert.equal(ran, true)
  assert.deepEqual(fs.readdirSync(lockPath), [])
})

test('withProfilesFileLock propagates unexpected acquisition errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-lock-'))
  const profilesPath = path.join(dir, 'profiles.json')
  const originalWriteFileSync = fs.writeFileSync

  try {
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      throw 'boom'
    }) as typeof fs.writeFileSync

    await assert.rejects(
      withProfilesFileLock(profilesPath, async () => undefined),
      /boom/,
    )
  } finally {
    fs.writeFileSync = originalWriteFileSync
  }
})

test('withProfilesFileLock ignores cleanup failures after success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-lock-'))
  const profilesPath = path.join(dir, 'profiles.json')
  const lockPath = `${profilesPath}.lock`
  const originalUnlinkSync = fs.unlinkSync

  try {
    fs.unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) => {
      throw new Error('cleanup failed')
    }) as typeof fs.unlinkSync

    await withProfilesFileLock(profilesPath, async () => undefined)
    assert.equal(fs.existsSync(lockPath), true)
  } finally {
    fs.unlinkSync = originalUnlinkSync
    if (fs.existsSync(lockPath)) {
      fs.rmSync(lockPath, { recursive: true, force: true })
    }
  }
})

test('live owners cannot be stolen after the old expiry threshold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-live-lock-'))
  try {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = withProfilesFileLock(path.join(dir, 'profiles'), async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await started
    await assert.rejects(
      withProfilesFileLock(
        path.join(dir, 'profiles'),
        async () => assert.fail('overlapping writer'),
        {
          now: () => Date.now() + 3600000,
          timeoutMs: 0,
        },
      ),
      /Timed out/,
    )
    release()
    await held
    await withProfilesFileLock(path.join(dir, 'profiles'), async () => {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function lockFixture(content?: string, foreign = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-lock-edge-'))
  const target = path.join(dir, 'profiles')
  const root = `${target}.lock`
  fs.mkdirSync(root)
  const host = foreign ? '0000000000000000' : getLockHostId()
  const peer = path.join(
    root,
    `${host}.2147483647.00000000-0000-0000-0000-000000000000`,
  )
  if (content !== undefined) fs.writeFileSync(peer, content)
  return {
    dir,
    target,
    root,
    peer,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test('lock liveness treats permission-denied probes as alive', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(2147483647), false)
  const kill = process.kill
  try {
    process.kill = (() => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' })
    }) as typeof process.kill
    assert.equal(isProcessAlive(1), true)
  } finally {
    process.kill = kill
  }
})

test('lock reaps only unique dead-process tickets including interrupted choosing flags', async () => {
  for (const content of ['0', '{incomplete', '"invalid"', '-1', '1.5', '3']) {
    const f = lockFixture(content)
    try {
      await withProfilesFileLock(
        f.target,
        async () => assert.equal(fs.existsSync(f.peer), false),
        { isProcessAlive: () => false },
      )
      assert.deepEqual(fs.readdirSync(f.root), [])
    } finally {
      f.cleanup()
    }
  }
})

test('foreign-host owners are never reaped on the basis of a local PID probe', async () => {
  const f = lockFixture('0', true)
  try {
    await assert.rejects(
      withProfilesFileLock(f.target, async () => assert.fail('overlap'), {
        timeoutMs: 0,
      }),
      /Timed out/,
    )
    assert.equal(fs.readFileSync(f.peer, 'utf8'), '0')
  } finally {
    f.cleanup()
  }
})

test('lock refuses invalid ticket overflow and unexpected read errors', async () => {
  const f = lockFixture(String(Number.MAX_SAFE_INTEGER))
  const read = fs.readFileSync
  try {
    await assert.rejects(
      withProfilesFileLock(f.target, async () => {}),
      /overflow/,
    )
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === f.peer) throw new Error('ticket read denied')
      return (read as Function)(...args)
    }) as typeof fs.readFileSync
    await assert.rejects(
      withProfilesFileLock(f.target, async () => {}),
      /ticket read denied/,
    )
  } finally {
    fs.readFileSync = read
    f.cleanup()
  }
})

test('ticket disappearance while scanning is benign; unexpected dead-ticket removal failures propagate', async () => {
  const f = lockFixture('1')
  const read = fs.readFileSync,
    unlink = fs.unlinkSync
  try {
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === f.peer) {
        fs.rmSync(f.peer, { force: true })
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }
      return (read as Function)(...args)
    }) as typeof fs.readFileSync
    await withProfilesFileLock(f.target, async () => {})
    fs.readFileSync = read
    fs.writeFileSync(f.peer, '1')
    fs.unlinkSync = ((name) => {
      if (name === f.peer)
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return unlink(name)
    }) as typeof fs.unlinkSync
    await assert.rejects(
      withProfilesFileLock(f.target, async () => {}, {
        isProcessAlive: () => false,
      }),
      /denied/,
    )
    fs.unlinkSync = ((name) => {
      if (name === f.peer) {
        unlink(name)
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }
      return unlink(name)
    }) as typeof fs.unlinkSync
    await withProfilesFileLock(f.target, async () => {}, {
      isProcessAlive: () => false,
    })
  } finally {
    fs.readFileSync = read
    fs.unlinkSync = unlink
    f.cleanup()
  }
})

test('legacy live locks and fresh malformed locks fail closed', async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-legacy-lock-'),
  )
  const target = path.join(dir, 'profiles'),
    root = `${target}.lock`
  try {
    fs.writeFileSync(root, JSON.stringify({ pid: process.pid }))
    await assert.rejects(
      withProfilesFileLock(target, async () => {}, {
        now: () => Date.now() + 3600000,
      }),
      /previous Codex Switch/,
    )
    fs.writeFileSync(root, 'bad')
    await assert.rejects(
      withProfilesFileLock(target, async () => {}),
      /previous Codex Switch/,
    )
    fs.writeFileSync(root, JSON.stringify({ pid: 2147483647 }))
    await withProfilesFileLock(target, async () => {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('directory creation and legacy cleanup errors are not hidden', async () => {
  const f = lockFixture()
  const mkdir = fs.mkdirSync,
    unlink = fs.unlinkSync
  try {
    fs.mkdirSync = (() => {
      throw new Error('mkdir denied')
    }) as typeof fs.mkdirSync
    await assert.rejects(
      withProfilesFileLock(f.target, async () => {}),
      /mkdir denied/,
    )
    fs.mkdirSync = mkdir
    fs.rmdirSync(f.root)
    fs.writeFileSync(f.root, JSON.stringify({ pid: 2147483647 }))
    fs.unlinkSync = (() => {
      throw new Error('legacy unlink denied')
    }) as typeof fs.unlinkSync
    await assert.rejects(
      withProfilesFileLock(f.target, async () => {}),
      /legacy unlink denied/,
    )
  } finally {
    fs.mkdirSync = mkdir
    fs.unlinkSync = unlink
    f.cleanup()
  }
})

test('contending independent processes do not lose updates', async () => {
  const f = lockFixture()
  const counter = path.join(f.dir, 'counter')
  fs.writeFileSync(counter, '0')
  const modulePath = path.resolve(
    __dirname,
    '../../src/utils/profiles-file-lock.js',
  )
  const source = `const fs = require('fs'); const {withProfilesFileLock} = require(process.argv[1]);
    (async () => { for (let i=0;i<5;i++) await withProfilesFileLock(process.argv[2],async()=>{
      const n=Number(fs.readFileSync(process.argv[3],'utf8'));
      await new Promise(r=>setTimeout(r,2)); fs.writeFileSync(process.argv[3],String(n+1));
    }) })().catch(e=>{console.error(e);process.exitCode=1})`
  try {
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ['-e', source, modulePath, f.target, counter],
              { stdio: ['ignore', 'ignore', 'pipe'] },
            )
            let stderr = ''
            child.stderr.on('data', (data) => {
              stderr += data
            })
            child.on('error', reject)
            child.on('close', (code) =>
              code === 0 ? resolve() : reject(new Error(stderr)),
            )
          }),
      ),
    )
    assert.equal(fs.readFileSync(counter, 'utf8'), '20')
  } finally {
    f.cleanup()
  }
})

test('PID namespace isolation prevents cross-container liveness assumptions', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const readlink = fs.readlinkSync
  try {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    })
    const native = getLockHostId()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    })
    fs.readlinkSync = (() => {
      throw new Error('proc unavailable')
    }) as typeof fs.readlinkSync
    const unknown = getLockHostId()
    assert.equal(getLockHostId(), unknown)
    assert.notEqual(unknown, native)
    fs.readlinkSync = (() =>
      'pid:[synthetic-namespace]') as unknown as typeof fs.readlinkSync
    assert.notEqual(getLockHostId(), unknown)
    assert.notEqual(getLockHostId(), native)
  } finally {
    fs.readlinkSync = readlink
    Object.defineProperty(process, 'platform', descriptor)
  }
})
