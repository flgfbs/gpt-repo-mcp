import type { ValidationProfile } from "../contracts/validation.contract.js";

export type CapturedValidationCommand = {
  profile: ValidationProfile;
  script: string;
  command: string;
  status: "passed" | "failed";
  exit_code?: number;
  signal?: string;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

export type ValidationArtifactCapture = {
  schema_version: 1;
  validation_id: string;
  repo_id: string;
  profile: ValidationProfile;
  status: "passed" | "failed";
  commands: CapturedValidationCommand[];
};

const VALIDATION_ARTIFACT_CAPTURE = Symbol("chat-pro-repository-mcp.validation-artifact-capture");

export function attachValidationArtifactCapture<T extends object>(
  target: T,
  capture: ValidationArtifactCapture
): T {
  Object.defineProperty(target, VALIDATION_ARTIFACT_CAPTURE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: capture
  });
  return target;
}

export function readValidationArtifactCapture(value: unknown): ValidationArtifactCapture | undefined {
  if (!value || typeof value !== "object") return undefined;
  return (value as { [VALIDATION_ARTIFACT_CAPTURE]?: ValidationArtifactCapture })[VALIDATION_ARTIFACT_CAPTURE];
}
