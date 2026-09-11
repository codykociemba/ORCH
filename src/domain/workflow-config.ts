/**
 * Repo-tracked team workflow configuration (.orch/workflow.yml).
 */

export interface WorkflowConfig {
  version: 1;
  orchestration?: {
    lead_adapter?: string;
    require_plan_before_dispatch?: boolean;
  };
  code_intelligence?: {
    provider?: 'gitnexus';
    required?: boolean;
    setup?: {
      auto_analyze?: boolean;
      require_current_index?: boolean;
    };
    pdg?: {
      default?: boolean;
      required_for?: string[];
    };
  };
  code_admission?: {
    enabled?: boolean;
    require_before_dispatch?: boolean;
    new_files?: { default?: 'require_approval' | 'allow' };
    new_dependencies?: { default?: 'require_approval' | 'allow' };
    new_symbols?: {
      exported?: 'require_approval' | 'allow';
      public?: 'require_approval' | 'allow';
      private_small_helper?: 'allow_if_within_approved_file' | 'require_approval';
      tests?: 'allow' | 'require_approval';
    };
    audit?: {
      require_git_diff?: boolean;
      require_gitnexus_detect_changes?: boolean;
      fail_on_partial?: boolean;
      fail_on_truncated?: boolean;
    };
    impact?: {
      low?: 'automatic' | 'require_approval';
      medium?: 'automatic' | 'require_approval';
      high?: 'require_approval';
      critical?: 'require_approval';
      unknown?: 'fail_closed';
    };
  };
  linear?: {
    enabled?: boolean;
    required_before_dispatch?: boolean;
    team_key?: string;
    api_key_env?: string;
  };
  github?: {
    enabled?: boolean;
    publish_proof?: boolean;
  };
  review?: {
    require_review_before_merge?: boolean;
    policy?: 'human' | 'cursor' | 'human_or_cursor' | 'human_and_cursor';
    accepted_reviewers?: string[];
  };
  council?: {
    enabled?: boolean;
    required_task_count?: number;
  };
  ponytail?: {
    enabled?: boolean;
    planning?: 'off' | 'lite' | 'full';
    implementation?: {
      default?: 'off' | 'lite' | 'full';
      low_risk_bounded?: 'off' | 'lite' | 'full';
      high_risk?: 'off' | 'lite' | 'full';
    };
    review?: 'off' | 'lite' | 'full';
  };
  wiki?: {
    enabled?: boolean;
    provider?: 'github' | 'gitlab' | 'auto';
    publish_from?: 'default_branch';
    generator?: {
      provider?: 'gitnexus';
      force?: boolean;
      language?: string;
      llm?: {
        provider?: string;
        model?: string;
      };
    };
  };
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  version: 1,
  orchestration: {
    lead_adapter: 'claude',
    require_plan_before_dispatch: false,
  },
  code_intelligence: {
    provider: 'gitnexus',
    required: false,
    setup: {
      auto_analyze: true,
      require_current_index: true,
    },
    pdg: { default: false },
  },
  code_admission: {
    enabled: false,
    require_before_dispatch: true,
    new_files: { default: 'require_approval' },
    new_dependencies: { default: 'require_approval' },
    new_symbols: {
      exported: 'require_approval',
      public: 'require_approval',
      private_small_helper: 'allow_if_within_approved_file',
      tests: 'allow',
    },
    audit: {
      require_git_diff: true,
      require_gitnexus_detect_changes: true,
      fail_on_partial: true,
      fail_on_truncated: true,
    },
    impact: {
      low: 'automatic',
      medium: 'automatic',
      high: 'require_approval',
      critical: 'require_approval',
      unknown: 'fail_closed',
    },
  },
  linear: {
    enabled: false,
    required_before_dispatch: false,
    api_key_env: 'LINEAR_API_KEY',
  },
  github: {
    enabled: true,
    publish_proof: true,
  },
  review: {
    require_review_before_merge: true,
    policy: 'human_or_cursor',
    accepted_reviewers: ['human', 'cursor'],
  },
  council: {
    enabled: true,
    required_task_count: 5,
  },
  ponytail: {
    enabled: true,
    planning: 'off',
    implementation: {
      default: 'lite',
      low_risk_bounded: 'full',
      high_risk: 'lite',
    },
    review: 'off',
  },
  wiki: {
    enabled: true,
    provider: 'auto',
    publish_from: 'default_branch',
    generator: {
      provider: 'gitnexus',
      force: false,
      llm: { provider: 'auto' },
    },
  },
};

export function isAdmissionEnabled(config: WorkflowConfig | null): boolean {
  return config?.code_admission?.enabled === true;
}

/** Written by `orch init` so a new repo has CE methodology without a second scheduler. */
export const DEFAULT_COMPOUND_YML = `# Compound Engineering is the planning/review/learning methodology.
# ORCH is the only execution scheduler. Do not run lfg or whole-plan ce-work
# against the same task graph.
methodology: compound-engineering
scheduler: orch
lead: claude
verify: codex
council:
  required_task_count: 5
  members:
    - claude
    - codex
    - cursor-grok
invoke:
  - ce-brainstorm
  - ce-plan
  - ce-doc-review
  - ce-code-review
  - ce-simplify-code
  - ce-compound
  - ce-compound-refresh
forbidden:
  - lfg
  - ce-work
learnings: docs/solutions
`;
