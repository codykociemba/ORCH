/**
 * Repo-tracked workflow config at .orch/workflow.yml
 */

import path from 'node:path';
import { readYaml, writeYaml } from './fs-utils.js';
import {
  DEFAULT_WORKFLOW_CONFIG,
  type WorkflowConfig,
} from '../../domain/workflow-config.js';

export class WorkflowConfigStore {
  constructor(private readonly projectRoot: string) {}

  get filePath(): string {
    return path.join(this.projectRoot, '.orch', 'workflow.yml');
  }

  async read(): Promise<WorkflowConfig | null> {
    const raw = await readYaml<WorkflowConfig>(this.filePath);
    if (!raw) return null;
    return {
      ...DEFAULT_WORKFLOW_CONFIG,
      ...raw,
      code_intelligence: {
        ...DEFAULT_WORKFLOW_CONFIG.code_intelligence,
        ...raw.code_intelligence,
      },
      code_admission: {
        ...DEFAULT_WORKFLOW_CONFIG.code_admission,
        ...raw.code_admission,
        new_files: {
          ...DEFAULT_WORKFLOW_CONFIG.code_admission?.new_files,
          ...raw.code_admission?.new_files,
        },
        new_dependencies: {
          ...DEFAULT_WORKFLOW_CONFIG.code_admission?.new_dependencies,
          ...raw.code_admission?.new_dependencies,
        },
        new_symbols: {
          ...DEFAULT_WORKFLOW_CONFIG.code_admission?.new_symbols,
          ...raw.code_admission?.new_symbols,
        },
        audit: {
          ...DEFAULT_WORKFLOW_CONFIG.code_admission?.audit,
          ...raw.code_admission?.audit,
        },
      },
    };
  }

  async write(config: WorkflowConfig): Promise<void> {
    await writeYaml(this.filePath, config);
  }
}
