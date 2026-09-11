/**
 * Library entry point.
 *
 * Re-exports domain types and core services for programmatic use.
 */

// Domain
export type { Task, TaskStatus, CreateTaskInput, WorkspaceMode, TaskProof } from './domain/task.js';
export type { Agent, AgentStatus, AgentConfig, CreateAgentInput, ApprovalPolicy, ReasoningEffort, AgentStats, AgentLastError } from './domain/agent.js';
export type { Run, RunStatus, RunEvent, RunEventType, TokenUsage } from './domain/run.js';
export { createTokenUsage } from './domain/run.js';
export type { OrchestratorConfig, ProjectConfig, SchedulingConfig } from './domain/config.js';
export type { OrchestratorState, RunningEntry, RetryEntry } from './domain/state.js';
export type { OrchestratorEvent, OrchestratorEventType, EventPayload } from './domain/events.js';
export { OrchestryError, NotInitializedError, TaskNotFoundError, AgentNotFoundError, GoalHasPendingTasksError, WorkspaceError, AdapterErrorKind, ERROR_HINTS, classifyAdapterError } from './domain/errors.js';
export type { AdapterErrorHint } from './domain/errors.js';
export { canTransition, isTerminal, isDispatchable, isBlocked, resolveFailureStatus } from './domain/transitions.js';
export type { AdapterKind, ModelTier } from './domain/model-tiers.js';
export { resolveModel, defaultModelForAdapter, isAdapterKind, isModelTier, MODEL_TIER_MAP, SUPPORTED_ADAPTERS } from './domain/model-tiers.js';
export type { AgentShopTemplate } from './domain/agent-shop.js';
export { AGENT_SHOP_TEMPLATES, getShopTemplateByKey } from './domain/agent-shop.js';

// Application
export { EventBus } from './application/event-bus.js';
export { templateToAgentInput, isMcpSkill } from './application/agent-factory.js';
export { TaskService } from './application/task-service.js';
export { AgentService } from './application/agent-service.js';
export { RunService } from './application/run-service.js';
export { Orchestrator } from './application/orchestrator.js';
export { CodeAdmissionService } from './application/code-admission-service.js';
export { ProofService } from './application/proof-service.js';
export { IntegrationService } from './application/integration-service.js';
export { WikiService } from './application/wiki-service.js';
export { ReuseAnalysisService } from './application/reuse-analysis-service.js';
export { resolvePonytailMode, renderPonytailPrompt } from './application/ponytail-policy.js';
export { buildPlanManifest, describeRoute } from './application/plan-router.js';
export { CouncilService } from './application/council-service.js';
export { verifySmallPlanReuse } from './application/plan-reuse-verifier.js';
export { passesDispatchGates } from './application/dispatch-policy.js';
export { parseCursorReview } from './application/cursor-review.js';
export type { WorkflowConfig } from './domain/workflow-config.js';
export { DEFAULT_WORKFLOW_CONFIG, isAdmissionEnabled } from './domain/workflow-config.js';
export type { ModificationContract } from './domain/modification-contract.js';
export type { AdmissionRequest, AdmissionAuditResult } from './domain/admission.js';
export type { ICodeIntelligence } from './infrastructure/code-intelligence/interface.js';
export { GitNexusCodeIntelligence } from './infrastructure/code-intelligence/gitnexus-adapter.js';

// Infrastructure interfaces
export type { IAgentAdapter, AgentEvent, ExecuteParams, AdapterTestResult } from './infrastructure/adapters/interface.js';
export { AdapterRegistry } from './infrastructure/adapters/registry.js';
export type { ISkillLoader } from './infrastructure/skills/skill-loader.js';
export { SkillLoader } from './infrastructure/skills/skill-loader.js';

// Clipboard
export { detectClipboardType, getClipboardImage, isClipboardToolAvailable } from './infrastructure/clipboard-service.js';
export type { ClipboardContentType, ClipboardImage } from './infrastructure/clipboard-service.js';

// Container
export { buildContainer, buildLightContainer, buildFullContainer } from './container.js';
export type { Container, LightContainer } from './container.js';
