/**
 * Durable integration outbox (idempotent Linear/GitHub sync).
 */

import { nanoid } from 'nanoid';
import type { Paths } from '../storage/paths.js';
import { ensureDir, listFiles, readJson, writeJson } from '../storage/fs-utils.js';
import type { OutboxEntry, OutboxStatus } from '../../domain/integration.js';

export class OutboxStore {
  constructor(private readonly paths: Paths) {}

  async enqueue(input: Omit<OutboxEntry, 'id' | 'created_at' | 'updated_at' | 'attempts' | 'status'> & {
    attempts?: number;
    status?: OutboxStatus;
  }): Promise<OutboxEntry> {
    const existing = await this.findByFingerprint(input.fingerprint);
    if (existing) return existing;
    const now = new Date().toISOString();
    const entry: OutboxEntry = {
      id: `obx_${nanoid(7)}`,
      attempts: input.attempts ?? 0,
      status: input.status ?? 'pending',
      created_at: now,
      updated_at: now,
      ...input,
    };
    await writeJson(this.paths.outboxPath(entry.id), entry);
    return entry;
  }

  async save(entry: OutboxEntry): Promise<void> {
    entry.updated_at = new Date().toISOString();
    await writeJson(this.paths.outboxPath(entry.id), entry);
  }

  async get(id: string): Promise<OutboxEntry | null> {
    return readJson<OutboxEntry>(this.paths.outboxPath(id));
  }

  async list(status?: OutboxStatus): Promise<OutboxEntry[]> {
    await ensureDir(this.paths.outboxDir);
    const files = await listFiles(this.paths.outboxDir, '.json');
    const loaded = await Promise.all(files.map((name) => readJson<OutboxEntry>(`${this.paths.outboxDir}/${name}`)));
    return loaded.filter((item): item is OutboxEntry => !!item && (!status || item.status === status));
  }

  async findByFingerprint(fingerprint: string): Promise<OutboxEntry | null> {
    const all = await this.list();
    return all.find((item) => item.fingerprint === fingerprint) ?? null;
  }
}
