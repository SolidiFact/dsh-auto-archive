/**
 * auto-archive: once a night, archive dsh sessions that are finished and have
 * not been used for three weeks.
 *
 * WHAT COUNTS AS FINISHED AND IDLE
 * A session is archived only when every one of these holds:
 *   - no activity for `idleDays` (21 by default), by dsh's own last-activity time;
 *   - it is not open, not running, and has nothing queued for its next turn;
 *   - its goal, if it has one, is complete (not active, paused or blocked);
 *   - every to-do item is completed;
 *   - it is not pinned, and not starred in @michengai/dsh-archive-manager;
 *   - it is a top-level session, not a sub-agent's (those follow their parent).
 * A session whose state cannot be read is kept. When in doubt, nothing moves.
 *
 * WHY IT IS SAFE TO RUN UNATTENDED
 * Archiving in dsh hides a session; it deletes nothing, and one click restores
 * it. The pass runs once a night inside a quiet window, skips the night if any
 * session is running, re-checks each session just before archiving it, and
 * never asks dsh to stop work: dsh itself refuses to archive a session with
 * running activity. Every pass is written to a ledger, one JSON line per night,
 * naming each session it archived, so any of them can be found and restored.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'auto-archive'
export const inject = ['sessionController', 'workspaceRegistry']

// --- Settings: what can be changed from cordis.patch.yml, and the defaults. ---

export const DEFAULTS = Object.freeze({
  idleDays: 21,
  runAt: '03:30', // local time the nightly window opens
  windowHours: 2, // how long the window stays open for a pass to find dsh idle
  checkEveryMs: 10 * 60_000,
  maxPerRun: 200,
  dryRun: false, // decide and record, archive nothing
  passOnStart: false, // one extra pass a minute after dsh starts (for trying it out)
  excludeFolders: [], // sessions whose project folder is one of these, or inside one, are never archived
  archiveEmpty: true, // archive sessions that were opened and never used
  restore: null, // "last", or a night as "YYYY-MM-DD": put back what that night archived, once
  ledger: join(homedir(), '.dsh', 'auto-archive', 'ledger.jsonl'),
})

const DAY_MS = 86_400_000

// --- Deciding: is one session finished and idle? Pure functions, no I/O. ---

/**
 * Why a session's own state says it is not finished, or null when it is.
 * @param values - the session's projection values from its session-list row.
 * @returns a short reason, or null.
 */
export function unfinishedReason (values) {
  const phase = values?.goal?.goal?.phase
  if (phase !== undefined && phase !== 'complete') return `goal-${phase}`
  const todos = values?.todos
  if (Array.isArray(todos) && todos.some((t) => t?.status !== 'completed')) return 'todos-unfinished'
  const inbox = values?.inbox
  if (inbox != null && ((inbox['next-turn']?.length ?? 0) > 0 || (inbox['next-step']?.length ?? 0) > 0)) return 'inbox-waiting'
  return null
}

/**
 * Decide one session-list row.
 * @param row - an item from dsh's session list.
 * @param facts - { now, idleDays, archived:Set, pinned:Set, favorites:Set, isOpen:(id)=>boolean }.
 * @returns { archive: boolean, reason: string }.
 */
export function decide (row, facts) {
  const id = row.sessionId
  if (facts.archived.has(id)) return { archive: false, reason: 'already-archived' }
  if (row.parentSessionId !== undefined) return { archive: false, reason: 'sub-agent' }
  if (facts.pinned.has(id)) return { archive: false, reason: 'pinned' }
  if (facts.favorites.has(id)) return { archive: false, reason: 'starred' }
  const restoredAt = facts.restored?.get(id)
  if (restoredAt !== undefined && !(row.updatedAt > restoredAt)) return { archive: false, reason: 'restored-by-you' }
  if (inFolders(row.cwd, facts.excludeFolders)) return { archive: false, reason: 'excluded-folder' }
  if (row.blank === true && facts.archiveEmpty === false) return { archive: false, reason: 'empty' }
  if (row.running) return { archive: false, reason: 'running' }
  if (row.agentAvailable || facts.isOpen(id)) return { archive: false, reason: 'open' }
  if (!Number.isFinite(row.updatedAt)) return { archive: false, reason: 'no-activity-time' }
  if (facts.now - row.updatedAt < facts.idleDays * DAY_MS) return { archive: false, reason: 'recent' }
  if (row.projections?.values === undefined) {
    // An empty session never started anything, so it has nothing unfinished.
    return row.blank === true ? { archive: true, reason: 'empty-and-idle' } : { archive: false, reason: 'state-unreadable' }
  }
  const unfinished = unfinishedReason(row.projections.values)
  if (unfinished !== null) return { archive: false, reason: unfinished }
  return { archive: true, reason: 'finished-and-idle' }
}

/**
 * Whether a session's project folder is one of the given folders or inside one.
 * @param cwd - the session's folder, or undefined.
 * @param folders - absolute folders, or starting with "~/".
 * @returns true when it matches.
 */
export function inFolders (cwd, folders = []) {
  if (typeof cwd !== 'string' || !Array.isArray(folders)) return false
  return folders.some((f) => {
    if (typeof f !== 'string' || f === '') return false
    const dir = (f.startsWith('~/') ? join(homedir(), f.slice(2)) : f).replace(/\/+$/, '')
    return cwd === dir || cwd.startsWith(dir + '/')
  })
}

/** A row's title for the ledger, whatever shape the title value has. */
export function titleOf (row) {
  const t = row.projections?.values?.title
  if (typeof t === 'string') return t
  if (t != null && typeof t === 'object') return t.title ?? t.text ?? t.value ?? ''
  return ''
}

// --- One pass: read the list, decide every row, archive what qualifies. ---

/**
 * Run one pass.
 * @param deps - { list:()=>Promise<rows>, registry, isOpen:(id)=>boolean, now:number, settings }.
 * @returns the ledger entry for this pass.
 */
export async function runPass ({ list, registry, isOpen, now, settings, restored = new Map() }) {
  const entry = { at: new Date(now).toISOString(), dryRun: settings.dryRun, idleDays: settings.idleDays }
  const rows = await list()
  if (rows.some((r) => r.running)) return { ...entry, skipped: 'a session is running' }

  let favorites = []
  if (typeof registry.favoriteSessions === 'function') {
    try {
      favorites = (await registry.favoriteSessions()).favoriteSessionIds ?? []
    } catch (error) {
      // Stars that cannot be read are not "no stars": skip the night rather than guess.
      return { ...entry, skipped: `could not read starred sessions: ${String(error)}` }
    }
  }
  const facts = () => ({
    now,
    idleDays: settings.idleDays,
    archived: new Set(registry.archivedSessionIds),
    pinned: new Set(registry.pinnedSessionIds ?? []),
    favorites: new Set(favorites),
    restored,
    excludeFolders: settings.excludeFolders,
    archiveEmpty: settings.archiveEmpty,
    isOpen,
  })

  const kept = {}
  const candidates = []
  const first = facts()
  for (const row of rows) {
    const d = decide(row, first)
    if (d.archive) candidates.push(row)
    else kept[d.reason] = (kept[d.reason] ?? 0) + 1
  }
  candidates.sort((a, b) => a.updatedAt - b.updatedAt)
  const batch = candidates.slice(0, settings.maxPerRun)

  const archived = []
  const failed = []
  for (const row of batch) {
    // Re-check against the registry and open sessions as they are now, not as they were.
    if (!decide(row, facts()).archive) { kept['changed-during-pass'] = (kept['changed-during-pass'] ?? 0) + 1; continue }
    const record = { id: row.sessionId, title: titleOf(row), lastActivity: new Date(row.updatedAt).toISOString() }
    if (settings.dryRun) { archived.push(record); continue }
    try {
      await registry.archiveSession(row.sessionId) // never { stopActivity: true }
      archived.push(record)
    } catch (error) {
      failed.push({ id: row.sessionId, error: String(error?.message ?? error) })
    }
  }
  return {
    ...entry,
    considered: rows.length,
    candidates: candidates.length,
    archived,
    left_for_next_night: Math.max(0, candidates.length - batch.length),
    kept,
    failed,
  }
}

// --- Schedule: one pass a night, inside the quiet window. ---

/**
 * Whether a pass is due now.
 * @param now - a Date.
 * @param lastDay - the local date (YYYY-MM-DD) of the last completed pass, or null.
 * @param runAt - "HH:MM" local.
 * @param windowHours - how long after runAt a pass may still start.
 * @returns true when inside tonight's window and tonight has not had a pass.
 */
export function due (now, lastDay, runAt, windowHours) {
  const [h, m] = runAt.split(':').map(Number)
  const open = new Date(now)
  open.setHours(h, m, 0, 0)
  const close = new Date(open.getTime() + windowHours * 3_600_000)
  return now >= open && now < close && lastDay !== localDay(now)
}

export function localDay (d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// --- Ledger: one JSON line per pass, read back to know whether tonight is done. ---

export function lastCompletedDay (path) {
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i])
      if (e.skipped === undefined && e.scheduled) return localDay(new Date(e.at))
    } catch { /* a torn line is ignored, never fatal */ }
  }
  return null
}

function record (path, entry) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(entry) + '\n')
}

function summary (e) {
  if (e.skipped) return `skipped: ${e.skipped}`
  const kept = Object.entries(e.kept).map(([k, v]) => `${k} ${v}`).join(', ')
  return `${e.dryRun ? 'dry run, would archive' : 'archived'} ${e.archived.length} of ${e.considered} sessions` +
    (e.left_for_next_night ? ` (${e.left_for_next_night} left for the next night)` : '') +
    (e.failed.length ? `, ${e.failed.length} failed` : '') + `; kept: ${kept}`
}

// --- Restoring: put back what one night archived, and keep it from being archived again. ---

/** Every readable ledger line, oldest first. */
export function readLedger (path) {
  if (!existsSync(path)) return []
  const entries = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch { /* a torn line is ignored */ }
  }
  return entries
}

/**
 * Sessions you restored, and when: they are kept until they are used again.
 * @param entries - the ledger.
 * @returns Map of session id to the time (ms) it was restored.
 */
export function restoredSessions (entries) {
  const out = new Map()
  for (const e of entries) for (const id of e.restored ?? []) out.set(id, Date.parse(e.at))
  return out
}

/**
 * Which night a `restore` setting names, and what that night archived.
 * @param entries - the ledger.
 * @param which - "last" or "YYYY-MM-DD" (local date).
 * @returns { night, ids } or { error }.
 */
export function nightToRestore (entries, which) {
  const real = entries.filter((e) => e.dryRun === false && Array.isArray(e.archived) && e.archived.length > 0)
  let night = which
  if (which === 'last') {
    if (real.length === 0) return { error: 'nothing has been archived yet' }
    night = localDay(new Date(real[real.length - 1].at))
  } else if (typeof which !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(which)) {
    return { error: `restore must be "last" or a date as YYYY-MM-DD, not ${JSON.stringify(which)}` }
  }
  const ids = [...new Set(real.filter((e) => localDay(new Date(e.at)) === night).flatMap((e) => e.archived.map((a) => a.id)))]
  if (ids.length === 0) return { error: `nothing was archived on ${night}` }
  return { night, ids }
}

/**
 * Put back what one night archived. Each night is restored once: the ledger remembers it, so
 * leaving the setting in place does nothing more.
 * @returns the ledger entry, or null when that night was already restored.
 */
export async function runRestore ({ registry, entries, which, now }) {
  const target = nightToRestore(entries, which)
  const at = new Date(now).toISOString()
  if (target.error) return { at, restoreOf: String(which), skipped: target.error }
  if (entries.some((e) => e.restoreOf === target.night && e.skipped === undefined)) return null
  const restored = []
  const failed = []
  for (const id of target.ids) {
    try {
      await registry.unarchiveSession(id)
      restored.push(id)
    } catch (error) {
      failed.push({ id, error: String(error?.message ?? error) })
    }
  }
  return { at, restoreOf: target.night, restored, failed }
}

// --- Plugin entry: attach to the running dsh, and stop cleanly on dispose. ---

export function apply (ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const list = ctx.sessionController?.listState
  const registry = ctx.workspaceRegistry
  if (typeof list?.list !== 'function' || typeof registry?.archiveSession !== 'function' || typeof registry?.unarchiveSession !== 'function' || !Array.isArray(registry?.archivedSessionIds)) {
    ctx.logger?.warn('auto-archive: this dsh has no session list or workspace registry to work with; nothing will be archived')
    return
  }
  const isOpen = (id) => ctx.get?.('sessions')?.get(id) !== undefined
  let running = false
  let lastDay = lastCompletedDay(settings.ledger)

  const pass = async (scheduled) => {
    if (running) return
    running = true
    try {
      const entry = await runPass({ list: () => list.list(), registry, isOpen, now: Date.now(), settings, restored: restoredSessions(readLedger(settings.ledger)) })
      entry.scheduled = scheduled
      record(settings.ledger, entry)
      if (scheduled && entry.skipped === undefined) lastDay = localDay(new Date(entry.at))
      console.log(`[auto-archive] ${summary(entry)}`)
    } catch (error) {
      console.warn(`[auto-archive] pass failed, nothing more will be tried until the next check: ${String(error)}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { if (due(new Date(), lastDay, settings.runAt, settings.windowHours)) pass(true) }, settings.checkEveryMs)
  const startTimer = settings.passOnStart ? setTimeout(() => pass(false), 60_000) : undefined
  const restoreTimer = settings.restore == null ? undefined : setTimeout(async () => {
    try {
      const entry = await runRestore({ registry, entries: readLedger(settings.ledger), which: settings.restore, now: Date.now() })
      if (entry === null) return // that night was restored before
      record(settings.ledger, entry)
      console.log(`[auto-archive] ${entry.skipped ? `restore skipped: ${entry.skipped}` : `restored ${entry.restored.length} sessions archived on ${entry.restoreOf}` + (entry.failed.length ? `, ${entry.failed.length} failed` : '') + '; they stay until you use them again'}`)
    } catch (error) {
      console.warn(`[auto-archive] restore failed: ${String(error)}`)
    }
  }, 5_000)
  console.log(`[auto-archive] nightly at ${settings.runAt}: sessions idle ${settings.idleDays}+ days and finished${settings.dryRun ? ' (dry run: nothing is archived)' : ''}; ledger ${settings.ledger}`)
  ctx.on('dispose', () => { clearInterval(timer); if (startTimer) clearTimeout(startTimer); if (restoreTimer) clearTimeout(restoreTimer) })
}
