export type OwnerCliIo = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  confirm?: (prompt: string) => Promise<string>;
};

export class OwnerCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OwnerCliError";
  }
}
