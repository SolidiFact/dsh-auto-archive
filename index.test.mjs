import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply, decide, due, inFolders, lastCompletedDay, localDay, nightToRestore, readLedger, restoredSessions, runPass, runRestore, titleOf, unfinishedReason, DEFAULTS,
} from './index.mjs'

// --- Fixtures shaped like dsh's own session-list rows. ---

const NOW = Date.UTC(2026, 9, 5, 7, 30)
const DAY = 86_400_000
const done = { goal: { goal: { id: 'g', revision: 1, objective: 'x', phase: 'complete' } }, todos: [{ content: 'a', status: 'completed' }], inbox: { 'next-turn': [], 'next-step': [] }, title: 'Old work' }
const row = (over = {}) => ({ sessionId: 's1', updatedAt: NOW - 30 * DAY, running: false, agentAvailable: false, blank: false, projections: { kind: 'cached', values: done }, ...over })
const facts = (over = {}) => ({ now: NOW, idleDays: 21, archived: new Set(), pinned: new Set(), favorites: new Set(), isOpen: () => false, ...over })

// --- What counts as finished. ---

test('a finished session idle for longer than the limit is archived', () => {
  assert.deepEqual(decide(row(), facts()), { archive: true, reason: 'finished-and-idle' })
})

test('a goal that is active, paused or blocked keeps the session', () => {
  for (const phase of ['active', 'paused', 'blocked']) {
    const values = { ...done, goal: { goal: { ...done.goal.goal, phase } } }
    assert.deepEqual(decide(row({ projections: { values } }), facts()), { archive: false, reason: `goal-${phase}` })
  }
})

test('any to-do that is not completed keeps the session', () => {
  for (const status of ['pending', 'in_progress']) {
    const values = { ...done, todos: [{ content: 'a', status: 'completed' }, { content: 'b', status }] }
    assert.equal(decide(row({ projections: { values } }), facts()).reason, 'todos-unfinished')
  }
})

test('messages queued for the next turn keep the session', () => {
  const values = { ...done, inbox: { 'next-turn': [{ text: 'later' }], 'next-step': [] } }
  assert.equal(decide(row({ projections: { values } }), facts()).reason, 'inbox-waiting')
})

test('no goal and no to-dos is finished', () => {
  assert.equal(unfinishedReason({ title: 't', goal: null, todos: null }), null)
})

// --- What is protected regardless. ---

test('recent, pinned, starred, open, running, sub-agent and archived sessions are kept', () => {
  assert.equal(decide(row({ updatedAt: NOW - 20 * DAY }), facts()).reason, 'recent')
  assert.equal(decide(row(), facts({ pinned: new Set(['s1']) })).reason, 'pinned')
  assert.equal(decide(row(), facts({ favorites: new Set(['s1']) })).reason, 'starred')
  assert.equal(decide(row(), facts({ isOpen: () => true })).reason, 'open')
  assert.equal(decide(row({ agentAvailable: true }), facts()).reason, 'open')
  assert.equal(decide(row({ running: true }), facts()).reason, 'running')
  assert.equal(decide(row({ parentSessionId: 'p' }), facts()).reason, 'sub-agent')
  assert.equal(decide(row(), facts({ archived: new Set(['s1']) })).reason, 'already-archived')
})

test('a session whose state cannot be read is kept, unless it is empty', () => {
  assert.equal(decide(row({ projections: undefined }), facts()).reason, 'state-unreadable')
  assert.deepEqual(decide(row({ projections: undefined, blank: true }), facts()), { archive: true, reason: 'empty-and-idle' })
  assert.equal(decide(row({ updatedAt: undefined }), facts()).reason, 'no-activity-time')
})

test('exactly at the limit is old enough; one millisecond short is not', () => {
  assert.equal(decide(row({ updatedAt: NOW - 21 * DAY }), facts()).archive, true)
  assert.equal(decide(row({ updatedAt: NOW - 21 * DAY + 1 }), facts()).archive, false)
})

test('titleOf reads a string or an object title', () => {
  assert.equal(titleOf(row()), 'Old work')
  assert.equal(titleOf(row({ projections: { values: { title: { title: 'T' } } } })), 'T')
  assert.equal(titleOf(row({ projections: undefined })), '')
})

// --- A pass, against a stand-in for dsh's registry. ---

function fakeRegistry ({ archived = [], pinned = [], favorites, refuse = [] } = {}) {
  const r = {
    archivedSessionIds: [...archived],
    pinnedSessionIds: [...pinned],
    calls: [],
    unarchived: [],
    async unarchiveSession (id) {
      r.unarchived.push(id)
      r.archivedSessionIds = r.archivedSessionIds.filter((x) => x !== id)
    },
    async archiveSession (id, options) {
      r.calls.push([id, options])
      if (refuse.includes(id)) throw new Error('workspace/session-active')
      r.archivedSessionIds.push(id)
    },
  }
  if (favorites !== undefined) r.favoriteSessions = async () => ({ favoriteSessionIds: favorites })
  return r
}
const settings = (over = {}) => ({ ...DEFAULTS, ...over })

test('a pass archives oldest first, never asks dsh to stop work, and records what it did', async () => {
  const rows = [row({ sessionId: 'new', updatedAt: NOW - 25 * DAY }), row({ sessionId: 'old', updatedAt: NOW - 90 * DAY }), row({ sessionId: 'hot', updatedAt: NOW - DAY })]
  const registry = fakeRegistry()
  const e = await runPass({ list: async () => rows, registry, isOpen: () => false, now: NOW, settings: settings() })
  assert.deepEqual(e.archived.map((a) => a.id), ['old', 'new'])
  assert.deepEqual(registry.calls, [['old', undefined], ['new', undefined]])
  assert.deepEqual(e.kept, { recent: 1 })
  assert.equal(e.archived[0].title, 'Old work')
})

test('a dry run decides and records but archives nothing', async () => {
  const registry = fakeRegistry()
  const e = await runPass({ list: async () => [row()], registry, isOpen: () => false, now: NOW, settings: settings({ dryRun: true }) })
  assert.equal(e.archived.length, 1)
  assert.equal(registry.calls.length, 0)
})

test('the night is skipped when any session is running', async () => {
  const registry = fakeRegistry()
  const e = await runPass({ list: async () => [row(), row({ sessionId: 'busy', running: true, updatedAt: NOW })], registry, isOpen: () => false, now: NOW, settings: settings() })
  assert.equal(e.skipped, 'a session is running')
  assert.equal(registry.calls.length, 0)
})

test('starred sessions from the archive manager are kept; unreadable stars skip the night', async () => {
  const kept = await runPass({ list: async () => [row()], registry: fakeRegistry({ favorites: ['s1'] }), isOpen: () => false, now: NOW, settings: settings() })
  assert.deepEqual(kept.kept, { starred: 1 })
  const broken = fakeRegistry()
  broken.favoriteSessions = async () => { throw new Error('storage closed') }
  const e = await runPass({ list: async () => [row()], registry: broken, isOpen: () => false, now: NOW, settings: settings() })
  assert.match(e.skipped, /could not read starred sessions/)
  assert.equal(broken.calls.length, 0)
})

test('a session opened during the pass is not archived', async () => {
  let opened = false
  const registry = fakeRegistry()
  const orig = registry.archiveSession
  registry.archiveSession = async (id, o) => { opened = true; return orig(id, o) }
  const rows = [row({ sessionId: 'a', updatedAt: NOW - 60 * DAY }), row({ sessionId: 'b', updatedAt: NOW - 30 * DAY })]
  const e = await runPass({ list: async () => rows, registry, isOpen: (id) => opened && id === 'b', now: NOW, settings: settings() })
  assert.deepEqual(e.archived.map((a) => a.id), ['a'])
  assert.equal(e.kept['changed-during-pass'], 1)
})

test('dsh refusing one session is recorded and the rest continue', async () => {
  const registry = fakeRegistry({ refuse: ['a'] })
  const rows = [row({ sessionId: 'a', updatedAt: NOW - 60 * DAY }), row({ sessionId: 'b', updatedAt: NOW - 30 * DAY })]
  const e = await runPass({ list: async () => rows, registry, isOpen: () => false, now: NOW, settings: settings() })
  assert.deepEqual(e.archived.map((a) => a.id), ['b'])
  assert.deepEqual(e.failed, [{ id: 'a', error: 'workspace/session-active' }])
})

test('no more than maxPerRun are archived in one night; the rest wait', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ sessionId: `s${i}`, updatedAt: NOW - (30 + i) * DAY }))
  const e = await runPass({ list: async () => rows, registry: fakeRegistry(), isOpen: () => false, now: NOW, settings: settings({ maxPerRun: 2 }) })
  assert.equal(e.archived.length, 2)
  assert.equal(e.left_for_next_night, 3)
})

// --- The schedule and the ledger. ---

test('a pass is due once a night, only inside the window', () => {
  const at = (h, m) => { const d = new Date(2026, 9, 5, h, m); return d }
  assert.equal(due(at(3, 29), null, '03:30', 2), false)
  assert.equal(due(at(3, 30), null, '03:30', 2), true)
  assert.equal(due(at(5, 29), null, '03:30', 2), true)
  assert.equal(due(at(5, 30), null, '03:30', 2), false)
  assert.equal(due(at(4, 0), localDay(at(4, 0)), '03:30', 2), false)
})

test('only a completed scheduled pass marks the night done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-archive-'))
  const path = join(dir, 'ledger.jsonl')
  assert.equal(lastCompletedDay(path), null)
  const day = new Date(2026, 9, 5, 3, 40)
  writeFileSync(path, [
    JSON.stringify({ at: day.toISOString(), scheduled: true, archived: [] }),
    JSON.stringify({ at: new Date(2026, 9, 6, 3, 40).toISOString(), scheduled: true, skipped: 'a session is running' }),
    JSON.stringify({ at: new Date(2026, 9, 6, 12, 0).toISOString(), scheduled: false, archived: [] }),
    '{torn',
  ].join('\n') + '\n')
  assert.equal(lastCompletedDay(path), localDay(day))
})

test('apply leaves dsh alone when the services it needs are missing', () => {
  const warnings = []
  apply({ sessionController: {}, workspaceRegistry: {}, logger: { warn: (m) => warnings.push(m) }, on () {} })
  assert.equal(warnings.length, 1)
})

// --- Settings: folders never archived, and empty sessions. ---

test('sessions in an excluded folder, or inside one, are kept', () => {
  const f = facts({ excludeFolders: ['/work/keep', '~/notes'] })
  assert.equal(decide(row({ cwd: '/work/keep' }), f).reason, 'excluded-folder')
  assert.equal(decide(row({ cwd: '/work/keep/sub' }), f).reason, 'excluded-folder')
  assert.equal(decide(row({ cwd: '/work/keeper' }), f).archive, true)
  assert.equal(inFolders(`${process.env.HOME}/notes/a`, ['~/notes']), true)
  assert.equal(inFolders(undefined, ['/x']), false)
})

test('archiveEmpty false keeps empty sessions; the default archives them', () => {
  const empty = row({ blank: true, projections: undefined })
  assert.equal(decide(empty, facts()).reason, 'empty-and-idle')
  assert.equal(decide(empty, facts({ archiveEmpty: false })).reason, 'empty')
})

// --- Restoring a night. ---

const night = (d, h, ids, extra = {}) => ({ at: new Date(2026, 9, d, h, 40).toISOString(), dryRun: false, scheduled: true, archived: ids.map((id) => ({ id })), ...extra })

test('restore "last" names the most recent night that archived something, ignoring dry runs', () => {
  const entries = [night(5, 3, ['a']), night(6, 3, ['b', 'c']), night(6, 4, ['d']), { ...night(7, 3, ['z']), dryRun: true }]
  assert.deepEqual(nightToRestore(entries, 'last'), { night: localDay(new Date(2026, 9, 6)), ids: ['b', 'c', 'd'] })
  assert.deepEqual(nightToRestore(entries, localDay(new Date(2026, 9, 5))).ids, ['a'])
  assert.match(nightToRestore(entries, 'yesterday').error, /must be "last" or a date/)
  assert.match(nightToRestore([], 'last').error, /nothing has been archived/)
})

test('a night is restored once, even if the setting stays in place', async () => {
  const registry = fakeRegistry({ archived: ['a', 'b'] })
  const entries = [night(6, 3, ['a', 'b'])]
  const first = await runRestore({ registry, entries, which: 'last', now: NOW })
  assert.deepEqual(first.restored, ['a', 'b'])
  assert.deepEqual(registry.unarchived, ['a', 'b'])
  const again = await runRestore({ registry, entries: [...entries, first], which: 'last', now: NOW })
  assert.equal(again, null)
  assert.equal(registry.unarchived.length, 2)
})

test('a restored session is kept until it is used again', () => {
  const restoredAt = NOW - DAY
  const restored = restoredSessions([{ at: new Date(restoredAt).toISOString(), restored: ['s1'] }])
  assert.equal(decide(row(), facts({ restored })).reason, 'restored-by-you')
  // Used after the restore, then idle for three weeks again: the normal rules apply.
  const usedLater = row({ updatedAt: restoredAt + 1 })
  assert.equal(decide(usedLater, facts({ restored, now: restoredAt + 1 + 22 * DAY })).archive, true)
})

test('readLedger skips torn lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-archive-'))
  const path = join(dir, 'ledger.jsonl')
  writeFileSync(path, '{"at":"x"}\n{torn\n\n{"at":"y"}\n')
  assert.deepEqual(readLedger(path).map((e) => e.at), ['x', 'y'])
})
