import { RootRegistry } from "../services/root-registry.js";
import type { CodeIntelligenceService } from "../services/code-intelligence-service.js";
import type { LifecycleRuntime } from "../services/lifecycle-runtime.js";
import type { TaskMutationRuntime } from "../services/task-mutation-runtime.js";
import type { AgentContinuationRuntime } from "../services/agent-continuation-service.js";
import type { ManagedFableReviewRuntime } from "../services/managed-fable-review-service.js";

export type RuntimeContext = {
  registry: RootRegistry;
  codeIntelligence?: CodeIntelligenceService;
  lifecycle?: LifecycleRuntime;
  taskMutations?: TaskMutationRuntime;
  agentContinuation?: AgentContinuationRuntime;
  fableReviews?: ManagedFableReviewRuntime;
};
