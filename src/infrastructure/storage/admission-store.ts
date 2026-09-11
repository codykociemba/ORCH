/**
 * Admission ledger + global reservations.
 */

import { nanoid } from 'nanoid';
import type { Paths } from './paths.js';
import { ensureDir, listFiles, readJson, writeJson } from './fs-utils.js';
import type { AdmissionRequest, Reservation, ReservationTable } from '../../domain/admission.js';
import { reservationKey } from '../../domain/admission.js';
import type { ModificationContract } from '../../domain/modification-contract.js';

export interface TaskAdmissionRecord {
  task_id: string;
  contract: ModificationContract;
  request_ids: string[];
}

export class AdmissionStore {
  private mutex: Promise<void> = Promise.resolve();
  private insideMutex = false;

  constructor(private readonly paths: Paths) {}

  async loadContract(taskId: string): Promise<ModificationContract | null> {
    const record = await this.loadTaskRecord(taskId);
    return record?.contract ?? null;
  }

  async saveContract(contract: ModificationContract): Promise<void> {
    await this.withMutex(async () => {
      const existing = await this.loadTaskRecord(contract.task_id);
      const record: TaskAdmissionRecord = {
        task_id: contract.task_id,
        contract,
        request_ids: existing?.request_ids ?? [],
      };
      await writeJson(this.paths.admissionTaskPath(contract.task_id), record);
    });
  }

  async saveRequest(request: AdmissionRequest): Promise<void> {
    await this.withMutex(async () => {
      await writeJson(this.paths.admissionRequestPath(request.id), request);
      const existing = await this.loadTaskRecord(request.task_id);
      if (existing && !existing.request_ids.includes(request.id)) {
        existing.request_ids.push(request.id);
        await writeJson(this.paths.admissionTaskPath(request.task_id), existing);
      }
    });
  }

  async getRequest(id: string): Promise<AdmissionRequest | null> {
    return readJson<AdmissionRequest>(this.paths.admissionRequestPath(id));
  }

  async listRequests(filter?: { taskId?: string; status?: AdmissionRequest['status'] }): Promise<AdmissionRequest[]> {
    await ensureDir(`${this.paths.admissionDir}/requests`);
    const files = await listFiles(`${this.paths.admissionDir}/requests`, '.json');
    const loaded = await Promise.all(
      files.map((name) => readJson<AdmissionRequest>(`${this.paths.admissionDir}/requests/${name}`)),
    );
    return loaded.filter((req): req is AdmissionRequest => {
      if (!req) return false;
      if (filter?.taskId && req.task_id !== filter.taskId) return false;
      if (filter?.status && req.status !== filter.status) return false;
      return true;
    });
  }

  async listReservations(): Promise<Reservation[]> {
    const table = await this.loadTable();
    return table.items;
  }

  async findReservation(kind: Reservation['kind'], input: { path?: string; name?: string; package?: string }): Promise<Reservation | null> {
    const key = reservationKey(kind, input);
    const table = await this.loadTable();
    return table.items.find((item) => item.key === key) ?? null;
  }

  async findReservationByName(name: string): Promise<Reservation | null> {
    const folded = name.trim().toLowerCase();
    const table = await this.loadTable();
    return table.items.find((item) => (item.name ?? '').toLowerCase() === folded) ?? null;
  }

  async addReservation(input: Omit<Reservation, 'key' | 'created_at'> & { created_at?: string }): Promise<Reservation> {
    return this.withMutex(async () => {
      const key = reservationKey(input.kind, input);
      const table = await this.loadTable();
      const existing = table.items.find((item) => item.key === key);
      if (existing) return existing;
      const reservation: Reservation = {
        ...input,
        key,
        created_at: input.created_at ?? new Date().toISOString(),
      };
      table.items.push(reservation);
      await writeJson(this.paths.reservationsPath, table);
      return reservation;
    });
  }

  async releaseTask(taskId: string): Promise<void> {
    await this.withMutex(async () => {
      const table = await this.loadTable();
      table.items = table.items.filter((item) => item.task_id !== taskId);
      await writeJson(this.paths.reservationsPath, table);
    });
  }

  async releaseStale(activeTaskIds: Set<string>): Promise<void> {
    await this.withMutex(async () => {
      const table = await this.loadTable();
      table.items = table.items.filter((item) => activeTaskIds.has(item.task_id));
      await writeJson(this.paths.reservationsPath, table);
    });
  }

  createRequestId(): string {
    return `adm_${nanoid(7)}`;
  }

  private async loadTaskRecord(taskId: string): Promise<TaskAdmissionRecord | null> {
    return readJson<TaskAdmissionRecord>(this.paths.admissionTaskPath(taskId));
  }

  private async loadTable(): Promise<ReservationTable> {
    const table = await readJson<ReservationTable>(this.paths.reservationsPath);
    if (!table) return { version: 1, items: [] };
    return { version: 1, items: table.items ?? [] };
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    if (this.insideMutex) return fn();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.mutex;
    this.mutex = prev.then(() => next);
    await prev;
    this.insideMutex = true;
    try {
      return await fn();
    } finally {
      this.insideMutex = false;
      release();
    }
  }
}
