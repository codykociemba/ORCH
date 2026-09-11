/**
 * Code intelligence port. Implemented by GitNexus; ORCH policy depends only on this.
 */

import type {
  CodeCandidate,
  CodeIndexStatus,
  DetectCodeChangesInput,
  ExistingCodeSearchInput,
  ExecutionProcess,
  ImpactInput,
  ImpactReport,
  ProcessQueryInput,
  RepositoryIdentityInput,
  SemanticChangeSet,
  SymbolContext,
  SymbolContextInput,
} from '../../domain/code-intelligence.js';

export interface ICodeIntelligence {
  getRepositoryStatus(input: RepositoryIdentityInput): Promise<CodeIndexStatus>;
  searchExisting(input: ExistingCodeSearchInput): Promise<CodeCandidate[]>;
  getSymbolContext(input: SymbolContextInput): Promise<SymbolContext>;
  getImpact(input: ImpactInput): Promise<ImpactReport>;
  getProcesses(input: ProcessQueryInput): Promise<ExecutionProcess[]>;
  detectChanges(input: DetectCodeChangesInput): Promise<SemanticChangeSet>;
  analyze?(input: RepositoryIdentityInput): Promise<void>;
  close?(): Promise<void>;
}

export interface IMcpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ICliRunner {
  run(
    command: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}
