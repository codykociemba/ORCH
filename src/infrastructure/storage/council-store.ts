/**
 * Durable council artifacts (votes, verdict, GitNexus evidence).
 */

import { nanoid } from 'nanoid';
import type { Paths } from './paths.js';
import { atomicWrite, ensureDir, listFiles, readJson, writeJson } from './fs-utils.js';
import { renderCouncilMarkdown, type CouncilResult } from '../../domain/council.js';

export class CouncilStore {
  constructor(private readonly paths: Paths) {}

  createId(): string {
    return `cnc_${nanoid(7)}`;
  }

  async save(result: CouncilResult): Promise<void> {
    await writeJson(this.paths.councilPath(result.id), result);
    if (!result.plan_id) return;
    await writeJson(this.paths.councilPlanJsonPath(result.plan_id), result);
    await atomicWrite(this.paths.councilPlanMarkdownPath(result.plan_id), renderCouncilMarkdown(result));
  }

  async get(id: string): Promise<CouncilResult | null> {
    return readJson<CouncilResult>(this.paths.councilPath(id));
  }

  async list(): Promise<CouncilResult[]> {
    await ensureDir(this.paths.councilDir);
    const files = await listFiles(this.paths.councilDir, '.json');
    const loaded = await Promise.all(
      files.map((name) => readJson<CouncilResult>(`${this.paths.councilDir}/${name}`)),
    );
    return loaded.filter((item): item is CouncilResult => !!item);
  }
}
