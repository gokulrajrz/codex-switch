import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ProfileManager } from '../../src/auth/profile-manager'
import { CodexHomeManager } from '../../src/codex-home/codex-home-manager'
import { buildCodexAuthJson } from '../../src/auth/codex-auth-sync'
import { buildProfileStateKeys } from '../../src/utils/profile-state-keys'
import { withProfilesFileLock } from '../../src/utils/profiles-file-lock'
import { buildProfileTokensFromAuth } from '../../src/utils/profile-records'
import { buildProfileSecretKeys } from '../../src/utils/profile-secret-keys'
import type { AuthData } from '../../src/types'

function auth(
  generation: number,
  accountId = 'workspace-A',
  user = 'user-A',
): AuthData {
  const claims = {
    sub: user,
    email: `${user}@example.test`,
    iat: generation,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
  }
  const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
  return {
    idToken,
    accessToken: `access-${generation}-${user}`,
    refreshToken: `refresh-${generation}-${user}`,
    email: claims.email,
    planType: 'plus',
    subject: user,
    accountId,
    authJson: {
      last_refresh: generation,
      tokens: {
        id_token: idToken,
        access_token: `access-${generation}-${user}`,
        refresh_token: `refresh-${generation}-${user}`,
        account_id: accountId,
      },
    },
  }
}
function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-switch-regression-'),
  )
  const home = path.join(root, 'custom-home')
  const storage = path.join(root, 'storage')
  const values = new Map<string, unknown>()
  const state = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
  }
  const tokens = new Map<string, string>()
  const hooks: {
    onTokenRead?: (key: string) => void
    onTokenStore?: (key: string, value: string) => void
  } = {}
  const createManager = () =>
    new ProfileManager(
      new CodexHomeManager({ initialCodexHome: home, codexHomeEnabled: true }),
      {
        fs,
        globalState: state,
        workspaceState: state,
        secrets: {
          get: async (key: string) => {
            hooks.onTokenRead?.(key)
            return tokens.get(key)
          },
          store: async (key: string, value: string) => {
            hooks.onTokenStore?.(key, value)
            tokens.set(key, value)
          },
          delete: async (key: string) => {
            tokens.delete(key)
          },
        },
        globalStorageUri: { fsPath: storage },
        remoteName: undefined,
        getConfiguration: () => ({
          get: (_key: string, fallback: unknown) => fallback,
        }),
        showErrorMessage: assert.fail,
        showWarningMessage: async () => undefined,
        showInformationMessage: () => {},
        translate: (text: string) => text,
      } as never,
    )
  const manager = createManager()
  const authPath = manager.getActiveCodexAuthPath()
  const writeLive = (data: AuthData | object) => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      authPath,
      JSON.stringify('idToken' in data ? data.authJson : data),
    )
  }
  const readLive = () => JSON.parse(fs.readFileSync(authPath, 'utf8'))
  return {
    root,
    storage,
    manager,
    createManager,
    authPath,
    values,
    state,
    tokens,
    hooks,
    writeLive,
    readLive,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('switching preserves newer live auth and publishes newer stored auth in both directions', async () => {
  const f = fixture()
  try {
    const saved = await f.manager.createProfile('A', auth(1))
    await f.manager.setActiveProfileId(saved.id)
    f.writeLive(auth(2))
    await f.manager.setActiveProfileId(saved.id)
    assert.equal(
      (await f.manager.loadAuthData(saved.id))?.refreshToken,
      auth(2).refreshToken,
    )
    assert.equal(f.readLive().tokens.refresh_token, auth(2).refreshToken)
    await f.manager.replaceProfileAuth(saved.id, auth(3))
    await f.manager.setActiveProfileId(saved.id)
    assert.equal(f.readLive().tokens.refresh_token, auth(3).refreshToken)
  } finally {
    f.cleanup()
  }
})

test('external workspace change clears the old active selection without replacing its credentials', async () => {
  const f = fixture()
  try {
    const a = await f.manager.createProfile('A', auth(1))
    await f.manager.setActiveProfileId(a.id)
    f.writeLive(auth(2, 'workspace-B'))
    await f.manager.reconcileActiveProfileWithCodexAuthFile()
    assert.equal(await f.manager.getActiveProfileId(), undefined)
    assert.equal((await f.manager.loadAuthData(a.id))?.accountId, 'workspace-A')
    const b = await f.manager.createProfile('B', auth(2, 'workspace-B'))
    assert.equal(await f.manager.getActiveProfileId(), b.id)
  } finally {
    f.cleanup()
  }
})

test('startup leaves API-key auth, corrupt auth and deliberate logout untouched', async () => {
  const f = fixture()
  try {
    const saved = await f.manager.createProfile('A', auth(1))
    await f.manager.setActiveProfileId(saved.id)
    f.writeLive({ OPENAI_API_KEY: 'synthetic-key' })
    await f.createManager().reconcileActiveProfileWithCodexAuthFile()
    assert.deepEqual(f.readLive(), { OPENAI_API_KEY: 'synthetic-key' })
    fs.writeFileSync(f.authPath, '{incomplete')
    await f.createManager().reconcileActiveProfileWithCodexAuthFile()
    assert.equal(fs.readFileSync(f.authPath, 'utf8'), '{incomplete')
    fs.unlinkSync(f.authPath)
    await f.createManager().reconcileActiveProfileWithCodexAuthFile()
    assert.equal(fs.existsSync(f.authPath), false)
  } finally {
    f.cleanup()
  }
})

test('new-login reset does not inherit default credentials on refresh or restart', async () => {
  const f = fixture()
  try {
    const saved = await f.manager.createProfile('Default', auth(1))
    f.values.set(buildProfileStateKeys('default').active, saved.id)
    // Fresh custom homes still bootstrap once.
    assert.equal(await f.manager.getActiveProfileId(), saved.id)
    await f.manager.prepareForNewLoginChat()
    assert.equal(await f.manager.getActiveProfileId(), undefined)
    const restarted = f.createManager()
    await restarted.reconcileActiveProfileWithCodexAuthFile()
    assert.equal(await restarted.getActiveProfileId(), undefined)
    assert.equal(fs.existsSync(f.authPath), false)
  } finally {
    f.cleanup()
  }
})

test(
  'failed live publication retains the previous selection and credentials',
  { skip: process.platform === 'win32' },
  async () => {
    const f = fixture()
    const rename = fs.renameSync
    try {
      const a = await f.manager.createProfile('A', auth(1))
      const b = await f.manager.createProfile(
        'B',
        auth(1, 'workspace-B', 'user-B'),
      )
      await f.manager.setActiveProfileId(a.id)
      fs.renameSync = ((from, to) => {
        if (to === f.authPath)
          throw new Error('synthetic auth publication failure')
        return rename(from, to)
      }) as typeof fs.renameSync
      await assert.rejects(
        f.manager.setActiveProfileId(b.id),
        /publication failure/,
      )
      assert.equal(await f.manager.getActiveProfileId(), a.id)
      assert.equal(
        fs.readFileSync(f.authPath, 'utf8'),
        buildCodexAuthJson(auth(1)),
      )
    } finally {
      fs.renameSync = rename
      f.cleanup()
    }
  },
)

test('switch waits for credential writers and reloads the target before publication', async () => {
  const f = fixture()
  try {
    const a = await f.manager.createProfile('A', auth(1))
    const b = await f.manager.createProfile(
      'B',
      auth(1, 'workspace-B', 'user-B'),
    )
    await f.manager.setActiveProfileId(a.id)
    let switching!: Promise<boolean>
    await withProfilesFileLock(
      path.join(f.storage, 'profiles.json'),
      async () => {
        switching = f.manager.setActiveProfileId(b.id)
        // Model a concurrent writer committing while holding the credential lock.
        f.tokens.set(
          buildProfileSecretKeys(b.id).current,
          JSON.stringify(
            buildProfileTokensFromAuth(auth(3, 'workspace-B', 'user-B')),
          ),
        )
      },
    )
    assert.equal(await switching, true)
    assert.equal(
      f.readLive().tokens.refresh_token,
      auth(3, 'workspace-B', 'user-B').refreshToken,
    )
  } finally {
    f.cleanup()
  }
})

test('conditional credential commit rejects a lost maintenance owner', async () => {
  const f = fixture()
  try {
    const a = await f.manager.createProfile('A', auth(1))
    assert.equal(
      await f.manager.replaceProfileAuthIfFresher(
        a.id,
        auth(2),
        auth(1),
        async () => false,
      ),
      'conflict',
    )
    assert.equal(
      (await f.manager.loadAuthData(a.id))?.refreshToken,
      auth(1).refreshToken,
    )
    assert.equal(
      await f.manager.replaceProfileAuthIfFresher(
        a.id,
        auth(2),
        auth(1),
        async () => {
          throw new Error('fence unavailable')
        },
      ),
      'failed',
    )
  } finally {
    f.cleanup()
  }
})

test('failed state commit rolls back live auth and previous-profile history', async () => {
  const f = fixture()
  const update = f.state.update
  try {
    const a = await f.manager.createProfile('A', auth(1))
    const b = await f.manager.createProfile(
      'B',
      auth(1, 'workspace-B', 'user-B'),
    )
    await f.manager.setActiveProfileId(a.id)
    await f.manager.setLastProfileId('previous-history')
    let failed = false
    f.state.update = async (key, value) => {
      if (
        !failed &&
        key.startsWith('codexSwitch.activeProfileId.') &&
        value === b.id
      ) {
        failed = true
        throw new Error('state commit failed')
      }
      await update(key, value)
    }
    await assert.rejects(
      f.manager.setActiveProfileId(b.id),
      /state commit failed/,
    )
    assert.equal(f.readLive().tokens.refresh_token, auth(1).refreshToken)
    assert.equal(await f.manager.getActiveProfileId(), a.id)
    assert.equal(await f.manager.getLastProfileId(), 'previous-history')
  } finally {
    f.state.update = update
    f.cleanup()
  }
})

test('switch aborts if another login changes while awaiting the credential lock', async () => {
  const f = fixture()
  try {
    const a = await f.manager.createProfile('A', auth(1))
    const b = await f.manager.createProfile(
      'B',
      auth(1, 'workspace-B', 'user-B'),
    )
    await f.manager.setActiveProfileId(a.id)
    let switching!: Promise<boolean>
    await withProfilesFileLock(
      path.join(f.storage, 'profiles.json'),
      async () => {
        let readTarget!: () => void
        const targetRead = new Promise<void>((resolve) => {
          readTarget = resolve
        })
        f.hooks.onTokenRead = (key) => {
          if (key === buildProfileSecretKeys(b.id).current) readTarget()
        }
        switching = f.manager.setActiveProfileId(b.id)
        await targetRead
        f.writeLive(auth(5, 'workspace-C', 'unsaved-user-C'))
      },
    )
    await assert.rejects(switching, /live login changed/)
    assert.equal(
      f.readLive().tokens.refresh_token,
      auth(5, 'workspace-C', 'unsaved-user-C').refreshToken,
    )
  } finally {
    f.cleanup()
  }
})

test('switching away refuses to discard live rotation when credential preservation fails', async () => {
  const f = fixture()
  try {
    const a = await f.manager.createProfile('A', auth(1))
    const b = await f.manager.createProfile(
      'B',
      auth(1, 'workspace-B', 'user-B'),
    )
    await f.manager.setActiveProfileId(a.id)
    // This can happen after the command-level save check but before switching.
    f.writeLive(auth(2))
    f.hooks.onTokenStore = (key) => {
      if (key === buildProfileSecretKeys(a.id).current) {
        throw new Error('synthetic credential store failure')
      }
    }
    await assert.rejects(
      f.manager.setActiveProfileId(b.id),
      /Could not preserve/,
    )
    assert.equal(f.readLive().tokens.refresh_token, auth(2).refreshToken)
    assert.equal(await f.manager.getActiveProfileId(), a.id)
    assert.equal(
      (await f.manager.loadAuthData(a.id))?.refreshToken,
      auth(1).refreshToken,
    )
  } finally {
    f.cleanup()
  }
})

test('failed selection commit restores the exact previous auth file, including unsupported modes', async () => {
  for (const original of [
    '{ "OPENAI_API_KEY": "synthetic-key" }\n',
    '{malformed-auth',
    null,
  ]) {
    const f = fixture()
    const update = f.state.update
    try {
      const target = await f.manager.createProfile('Target', auth(1))
      if (original !== null) {
        fs.mkdirSync(path.dirname(f.authPath), { recursive: true })
        fs.writeFileSync(f.authPath, original)
      }
      let failed = false
      f.state.update = async (key, value) => {
        if (
          !failed &&
          key.startsWith('codexSwitch.activeProfileId.') &&
          value === target.id
        ) {
          failed = true
          throw new Error('synthetic selection failure')
        }
        await update(key, value)
      }
      await assert.rejects(
        f.manager.setActiveProfileId(target.id),
        /selection failure/,
      )
      if (original === null) assert.equal(fs.existsSync(f.authPath), false)
      else assert.equal(fs.readFileSync(f.authPath, 'utf8'), original)
    } finally {
      f.state.update = update
      f.cleanup()
    }
  }
})
