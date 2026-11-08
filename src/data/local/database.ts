import Dexie, { type EntityTable } from 'dexie'

export type LocalRecord = { id: string; ownerId: string; updatedAt: string; version: number; syncState: 'local' | 'pending' | 'synced' | 'conflict' }
export type OutboxCommand = { id: string; actorId: string; scopeId: string; operation: string; payload: unknown; expectedVersion: number | null; createdAt: string; retries: number; state: 'queued' | 'retry' | 'blocked' }
export type SyncCursor = { ownerId: string; cursor: number; updatedAt: string }
export type ConflictRecord = { id: string; ownerId: string; entityId: string; local: unknown; remote: unknown; createdAt: string }
export type MediaUpload = { id: string; ownerId: string; blob: Blob; checksum: string; createdAt: string; retries: number }

class MoneyMateDatabase extends Dexie {
  records!: EntityTable<LocalRecord, 'id'>
  outbox!: EntityTable<OutboxCommand, 'id'>
  cursors!: EntityTable<SyncCursor, 'ownerId'>
  conflicts!: EntityTable<ConflictRecord, 'id'>
  mediaQueue!: EntityTable<MediaUpload, 'id'>

  constructor() {
    super('moneymate')
    this.version(1).stores({
      records: 'id, ownerId, updatedAt, [ownerId+syncState]',
      outbox: 'id, actorId, scopeId, createdAt, state, [actorId+state]',
      cursors: 'ownerId, updatedAt',
      conflicts: 'id, ownerId, entityId, createdAt',
      mediaQueue: 'id, ownerId, checksum, createdAt'
    })
  }
}

export const db = new MoneyMateDatabase()

export async function enqueueCommand(command: OutboxCommand): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    await db.outbox.put(command)
  })
}

export async function clearUserPartition(ownerId: string): Promise<void> {
  await db.transaction('rw', db.records, db.outbox, db.cursors, db.conflicts, db.mediaQueue, async () => {
    await Promise.all([
      db.records.where('ownerId').equals(ownerId).delete(),
      db.outbox.where('actorId').equals(ownerId).delete(),
      db.cursors.delete(ownerId),
      db.conflicts.where('ownerId').equals(ownerId).delete(),
      db.mediaQueue.where('ownerId').equals(ownerId).delete()
    ])
  })
}
