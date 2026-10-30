import type { AuthData, ProfileSummary } from '../types'
import { shouldReplaceStoredProfileAuthWithLive } from '../utils/auth-refresh-policy'
import { resolveDefaultHomeActiveProfileId } from '../utils/shared-active-profile'
import { buildProfileStateKeys } from '../utils/profile-state-keys'
import {
  isNonDefaultPerHomeState,
  shouldMigrateLegacyProfileState,
} from '../utils/profile-state-policy'
import { resolveProfileStateBucket } from '../utils/profile-state-buckets'
import { setActiveProfileIdInState } from '../utils/profile-active-state'
import {
  readLastProfileIdFromState,
  toggleLastProfileId,
  writeLastProfileIdToState,
} from '../utils/profile-last-state'
import { matchesPreservationIdentityForProfile } from '../utils/preservation-identity'
import type { ResolvedCodexHome } from '../types'
import type { ConfigurationGetter, StateStore } from './runtime-adapters'

const ACTIVE_PROFILE_KEY = 'codexSwitch.activeProfileId'
const LAST_PROFILE_KEY = 'codexSwitch.lastProfileId'
const OLD_ACTIVE_PROFILE_KEY = 'codexUsage.activeProfileId'
const OLD_LAST_PROFILE_KEY = 'codexUsage.lastProfileId'

/**
 * Dependencies for ProfileStateService.
 */
interface ProfileStateServiceDeps {
  /** Keeps original file bytes in memory so failed switches can restore any auth mode. */
  captureLiveAuthSnapshot?: () => { revision: string; restore: () => void }
  /** Detects external login changes during asynchronous switching work. */
  readLiveAuthRevision?: () => string
  /** Shared marker presence also records deliberate logout across clients. */
  hasHomeBeenInitialized?: () => boolean
  /** Serializes target reload and publication against credential updates. */
  withCredentialsLock?: <T>(action: () => Promise<T>) => Promise<T>
  /** Function to get the active Codex home configuration. */
  getActiveCodexHome: () => ResolvedCodexHome
  /** Configuration getter for accessing VS Code settings. */
  getConfiguration: ConfigurationGetter
  /** Global VS Code state storage. */
  globalState: StateStore
  /** Workspace-level VS Code state storage. */
  workspaceState: StateStore
  /** Function indicating whether remote files mode is enabled. */
  isRemoteFilesMode: () => boolean
  /** Function to retrieve a profile by ID. */
  getProfile: (profileId: string) => Promise<ProfileSummary | undefined>
  /** Function to load authentication data for a profile. */
  loadAuthData: (profileId: string) => Promise<AuthData | null>
  /** Function to load the current live Codex authentication data. */
  loadLiveCodexAuthData: () => Promise<AuthData | null>
  /** Function to infer active profile ID from auth file. */
  inferActiveProfileIdFromAuthFile: () => Promise<string | undefined>
  /** Function to recover missing tokens for a profile. */
  recoverMissingTokens: (profileId: string) => Promise<AuthData | null>
  /** Function to preserve stored profile auth from live auth file. */
  preserveStoredProfileAuthFromLive: (profileId: string) => Promise<void>
  /** Function to sync profile auth to Codex auth file. */
  syncProfileAuthToCodexAuthFile: (
    profileId: string,
    authData: AuthData,
  ) => void
  /** Function to reset internal sync cache. */
  resetSyncCache: () => void
  /** Function to read the shared active profile ID. */
  readSharedActiveProfile: () => string | undefined
  /** Function to read the default home shared active profile ID. */
  readDefaultHomeSharedActiveProfileId: () => string | undefined
  /** Function to read the default home legacy shared active profile ID. */
  readDefaultHomeSharedLegacyActiveProfileId: () => string | undefined
  /** Function to write a shared active profile marker. */
  writeSharedActiveProfile: (profileId: string) => void
  /** Function to delete the shared active profile marker. */
  deleteSharedActiveProfile: () => void
  /** Function to check if an active Codex auth file exists. */
  hasActiveCodexAuthFile: () => boolean
  /** Function to delete the active Codex auth file. */
  deleteActiveCodexAuthFile: () => void
}

/**
 * Manages the state of the active and last-used profiles.
 * Handles profile switching, history tracking, and state persistence
 * across global and workspace scopes.
 */
export class ProfileStateService {
  /**
   * Creates a new ProfileStateService instance.
   * @param deps - Dependencies for profile state management.
   */
  constructor(private readonly deps: ProfileStateServiceDeps) {}

  private getStateBucket(): StateStore {
    const newCfg = this.deps.getConfiguration('codexSwitch')
    const scopeFromNew = newCfg.get<'global' | 'workspace'>(
      'activeProfileScope',
    )
    const scope =
      scopeFromNew ||
      this.deps
        .getConfiguration('codexUsage')
        .get<'global' | 'workspace'>('activeProfileScope', 'global')
    return resolveProfileStateBucket(
      scope,
      this.deps.globalState,
      this.deps.workspaceState,
    )
  }

  private getLegacyStateBucket(): StateStore {
    const scope = this.deps
      .getConfiguration('codexUsage')
      .get<'global' | 'workspace'>('activeProfileScope', 'global')
    return resolveProfileStateBucket(
      scope,
      this.deps.globalState,
      this.deps.workspaceState,
    )
  }

  private activeProfileKey(): string {
    return buildProfileStateKeys(this.deps.getActiveCodexHome().id).active
  }

  private lastProfileKey(): string {
    return buildProfileStateKeys(this.deps.getActiveCodexHome().id).last
  }

  private shouldMigrateLegacyProfileState(): boolean {
    return shouldMigrateLegacyProfileState(this.deps.getActiveCodexHome())
  }

  private shouldInheritDefaultProfileWhenEmpty(): boolean {
    const cfg = this.deps.getConfiguration('codexSwitch')
    return cfg.get<boolean>('codexHome.inheritDefaultProfileWhenEmpty', true)
  }

  private isNonDefaultPerHomeState(): boolean {
    return isNonDefaultPerHomeState(this.deps.getActiveCodexHome())
  }

  private isActiveCodexAuthFileMissing(): boolean {
    return !this.deps.hasActiveCodexAuthFile()
  }

  private async getDefaultHomeActiveProfileId(): Promise<string | undefined> {
    return resolveDefaultHomeActiveProfileId(
      this.deps.readDefaultHomeSharedActiveProfileId(),
      this.deps.readDefaultHomeSharedLegacyActiveProfileId(),
      this.getStateBucket().get<string>(`${ACTIVE_PROFILE_KEY}.default`),
      this.getStateBucket().get<string>(ACTIVE_PROFILE_KEY),
      this.getStateBucket().get<string>(OLD_ACTIVE_PROFILE_KEY),
      this.getLegacyStateBucket().get<string>(OLD_ACTIVE_PROFILE_KEY),
      this.deps.isRemoteFilesMode(),
    )
  }

  private initializedKey(): string {
    return `codexSwitch.homeInitialized.${this.deps.getActiveCodexHome().id}`
  }

  /** Bootstrap an uninitialized custom home only; logout never qualifies. */
  async bootstrapEmptyHome(): Promise<void> {
    if (
      !this.isNonDefaultPerHomeState() ||
      !this.shouldInheritDefaultProfileWhenEmpty() ||
      this.deps.globalState.get<boolean>(this.initializedKey()) ||
      this.deps.hasHomeBeenInitialized?.() ||
      this.deps.hasActiveCodexAuthFile()
    ) {
      return
    }
    const id = await this.getDefaultHomeActiveProfileId()
    if (!id) {
      return
    }
    const publish = async () => {
      if (
        this.deps.hasActiveCodexAuthFile() ||
        this.deps.globalState.get<boolean>(this.initializedKey()) ||
        this.deps.hasHomeBeenInitialized?.()
      ) {
        return
      }
      const auth = await this.deps.loadAuthData(id)
      if (!auth) {
        return
      }
      this.deps.syncProfileAuthToCodexAuthFile(id, auth)
      await this.setActiveProfileIdInState(id)
      await this.deps.globalState.update(this.initializedKey(), true)
    }
    await (this.deps.withCredentialsLock
      ? this.deps.withCredentialsLock(publish)
      : publish())
  }

  /**
   * Gets the ID of the currently active profile.
   * Resolves state from both current and legacy storage keys.
   * @returns A promise that resolves to the active profile ID, or undefined if none is active.
   */
  async getActiveProfileId(): Promise<string | undefined> {
    const live = await this.deps.loadLiveCodexAuthData()
    const previous =
      (this.deps.isRemoteFilesMode()
        ? this.deps.readSharedActiveProfile()
        : this.getStateBucket().get<string>(this.activeProfileKey())) ||
      undefined
    const inferred = live
      ? await this.deps.inferActiveProfileIdFromAuthFile()
      : undefined
    if (live || this.deps.hasActiveCodexAuthFile() || previous) {
      await this.deps.globalState.update(this.initializedKey(), true)
    } else {
      await this.bootstrapEmptyHome()
      if (this.deps.hasActiveCodexAuthFile()) {
        return this.getActiveProfileId()
      }
    }
    if (previous !== inferred) {
      if (previous) {
        await this.setLastProfileId(previous)
      }
      await this.setActiveProfileIdInState(inferred)
    }
    return inferred
  }

  /**
   * Prepares the state for a new login in Codex chat.
   * Clears the active profile and optionally removes the auth file.
   * @returns A promise that resolves to the preparation result.
   */
  async prepareForNewLoginChat(): Promise<{ removedAuthFile: boolean }> {
    await this.deps.globalState.update(this.initializedKey(), true)
    this.deps.resetSyncCache()

    if (!this.deps.hasActiveCodexAuthFile()) {
      await this.setActiveProfileIdInState(undefined)
      return { removedAuthFile: false }
    }

    this.deps.deleteActiveCodexAuthFile()
    await this.setActiveProfileIdInState(undefined)

    return { removedAuthFile: true }
  }

  /**
   * Writes the active profile ID to state storage.
   * Updates both local and remote shared state as needed.
   * @param profileId - The profile ID to set as active, or undefined to clear.
   * @returns A promise that resolves when the operation completes.
   */
  async setActiveProfileIdInState(
    profileId: string | undefined,
  ): Promise<void> {
    await setActiveProfileIdInState(
      {
        isRemoteFilesMode: this.deps.isRemoteFilesMode(),
        currentBucket: this.getStateBucket(),
        keys: {
          current: this.activeProfileKey(),
          legacy: OLD_ACTIVE_PROFILE_KEY,
        },
        writeSharedActiveProfile: (profileId) =>
          this.deps.writeSharedActiveProfile(profileId),
        deleteSharedActiveProfile: () => this.deps.deleteSharedActiveProfile(),
      },
      profileId,
    )
  }

  /**
   * Sets the currently active profile by ID.
   * Loads auth data, preserves previous auth, and syncs to the Codex auth file.
   * @param profileId - The profile ID to activate, or undefined to deactivate all profiles.
   * @returns A promise that resolves to true if successful, false if auth data could not be loaded.
   */
  async setActiveProfileId(profileId: string | undefined): Promise<boolean> {
    const prev = await this.getActiveProfileId()
    const baselineSnapshot = this.deps.captureLiveAuthSnapshot?.()
    const baselineRevision =
      baselineSnapshot?.revision ?? this.deps.readLiveAuthRevision?.()

    if (
      profileId &&
      !(await this.deps.loadAuthData(profileId)) &&
      !(await this.deps.recoverMissingTokens(profileId))
    ) {
      return false
    }

    if (prev && profileId) {
      await this.deps.preserveStoredProfileAuthFromLive(prev)
    }
    const publish = async () => {
      if (!profileId) {
        await this.setActiveProfileIdInState(undefined)
        return true
      }
      // Recovery/preservation can await UI or storage. Reload under the store
      // lock so maintenance cannot rotate the selected bundle before publication.
      const latest = await this.deps.loadAuthData(profileId)
      if (!latest) {
        return false
      }
      const live = await this.deps.loadLiveCodexAuthData()
      const selected = await this.deps.getProfile(profileId)
      if (
        selected &&
        live &&
        matchesPreservationIdentityForProfile(selected, live, latest) &&
        shouldReplaceStoredProfileAuthWithLive(latest, live)
      ) {
        throw new Error(
          'Live credentials changed during switching. Retry to preserve the newer login.',
        )
      }
      const previousLast = await this.getLastProfileId()
      if (
        this.deps.readLiveAuthRevision &&
        this.deps.readLiveAuthRevision() !== baselineRevision
      ) {
        throw new Error(
          'The live login changed while switching. Retry to preserve the current account.',
        )
      }
      // Publish first. A failed file write must not commit a new selection.
      this.deps.syncProfileAuthToCodexAuthFile(profileId, latest)
      const publishedRevision = this.deps.readLiveAuthRevision?.()
      try {
        await this.setActiveProfileIdInState(profileId)
        if (prev && prev !== profileId) {
          await this.setLastProfileId(prev)
        }
        await this.deps.globalState.update(this.initializedKey(), true)
      } catch (error) {
        if (
          !this.deps.readLiveAuthRevision ||
          this.deps.readLiveAuthRevision() === publishedRevision
        ) {
          if (baselineSnapshot) {
            baselineSnapshot.restore()
          } else if (live) {
            this.deps.syncProfileAuthToCodexAuthFile(prev || profileId, live)
          } else {
            this.deps.deleteActiveCodexAuthFile()
          }
        }
        this.deps.resetSyncCache()
        await this.setActiveProfileIdInState(prev)
        await this.setLastProfileId(previousLast)
        throw error
      }
      return true
    }
    return this.deps.withCredentialsLock
      ? this.deps.withCredentialsLock(publish)
      : publish()
  }

  /**
   * Synchronizes the active profile from the default home's shared state.
   * Only applicable in remote files mode.
   * @returns A promise that resolves to the synced profile ID, or undefined if not found.
   */
  async syncActiveProfileFromDefaultHome(): Promise<string | undefined> {
    const defaultProfileId = await this.getDefaultHomeActiveProfileId()
    if (!defaultProfileId) {
      return undefined
    }
    const ok = await this.setActiveProfileId(defaultProfileId)
    return ok ? defaultProfileId : undefined
  }

  /**
   * Gets the ID of the last active profile before the current one.
   * @returns A promise that resolves to the last profile ID, or undefined if no previous profile exists.
   */
  async getLastProfileId(): Promise<string | undefined> {
    return readLastProfileIdFromState(
      this.getStateBucket(),
      this.getLegacyStateBucket(),
      {
        current: this.lastProfileKey(),
        currentBase: LAST_PROFILE_KEY,
        legacy: OLD_LAST_PROFILE_KEY,
      },
      this.shouldMigrateLegacyProfileState(),
    )
  }

  /**
   * Sets the ID of the last active profile.
   * @param profileId - The profile ID to store, or undefined to clear the last profile.
   * @returns A promise that resolves when the operation completes.
   */
  async setLastProfileId(profileId: string | undefined): Promise<void> {
    await writeLastProfileIdToState(
      this.getStateBucket(),
      {
        current: this.lastProfileKey(),
        currentBase: LAST_PROFILE_KEY,
        legacy: OLD_LAST_PROFILE_KEY,
      },
      profileId,
    )
  }

  /**
   * Toggles between the current and previous active profiles.
   * @returns A promise that resolves to the newly activated profile ID, or undefined if toggle failed.
   */
  async toggleLastProfileId(): Promise<string | undefined> {
    const active = await this.getActiveProfileId()
    const last = await this.getLastProfileId()
    return toggleLastProfileId(
      active,
      last,
      async (profileId) => this.setActiveProfileId(profileId),
      async (profileId) => this.setLastProfileId(profileId),
    )
  }
}
