import { RootRegistry } from "../services/root-registry.js";
import type { CodeIntelligenceService } from "../services/code-intelligence-service.js";
import type { LifecycleRuntime } from "../services/lifecycle-runtime.js";
import type { TaskMutationRuntime } from "../services/task-mutation-runtime.js";

export type RuntimeContext = {
  registry: RootRegistry;
  codeIntelligence?: CodeIntelligenceService;
  lifecycle?: LifecycleRuntime;
  taskMutations?: TaskMutationRuntime;
};
