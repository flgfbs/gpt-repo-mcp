#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runConnectGptCli } from "./connect-gpt.js";

export { runConnectGptCli as runChatProRepoCli } from "./connect-gpt.js";

const currentModule = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === currentModule) {
  process.exitCode = await runConnectGptCli(process.argv.slice(2));
}
