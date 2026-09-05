import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { CodexTaskMessageGrant } from "../config/task-messaging.js";
import { CodexAppServerTurnStartError, type CodexAppServerRpc } from "../delegation/codex-app-server-adapter.js";
import { canonicalSha256 } from "../task-runtime/canonical-json.js";

const Id = z.string().min(1).max(256);
const Thread = z.object({
  id: Id, sessionId: Id, createdAt: z.number().int(), cwd: z.string().max(4_096),
  projectId: Id.nullable(), modelProvider: Id, source: z.string(),
  ephemeral: z.literal(false), historyMode: z.enum(["legacy", "paginated"]),
  status: z.object({ type: z.enum(["idle", "active", "notLoaded", "systemError"]) }),
  canAcceptDirectInput: z.boolean().nullable()
});
export const FORWARDING_TOOL_NAME = "repo_send_task_message";
export class MessageTransportFailure extends Error {
  constructor(readonly reason: "binding_mismatch" | "offline" | "readback_mismatch" | "readback_unavailable") {
    super(reason);
  }
}

/** Existing local control connection only. No resume, injection, raw roles or overrides. */
export class AppServerTaskMessageTransport {
  constructor(private readonly rpc: Pick<CodexAppServerRpc, "request">, private readonly timeoutMs = 5_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) throw new Error("Invalid messaging timeout.");
  }

  async inspect(grant: CodexTaskMessageGrant): Promise<z.infer<typeof Thread>> {
    let thread: z.infer<typeof Thread>;
    try { thread = Thread.parse((await this.request("thread/read", { threadId: grant.target_id, includeTurns: false }) as { thread: unknown }).thread); }
    catch (error) {
      if (error instanceof MessageTransportFailure) throw error;
      throw new MessageTransportFailure("binding_mismatch");
    }
    let canonical: string;
    try { canonical = await realpath(grant.cwd); } catch { throw new MessageTransportFailure("binding_mismatch"); }
    if (canonical !== grant.cwd || thread.cwd !== canonical || thread.id !== grant.target_id
      || thread.sessionId !== grant.session_id || thread.createdAt !== grant.created_at
      || thread.projectId !== grant.project_id || thread.modelProvider !== grant.model_provider || thread.source !== grant.source) {
      throw new MessageTransportFailure("binding_mismatch");
    }
    return thread;
  }

  async send(grant: CodexTaskMessageGrant, envelope: string): Promise<{ turn_id: string } | { rejected: true }> {
    try {
      // This is the actual forwarding tool's result, not a fabricated user or executed command.
      // Explicit continuation admits both idle generation and the protocol's active-turn feed.
      const result = await this.request("turn/start", {
        threadId: grant.target_id, input: [],
        toolOutput: { name: FORWARDING_TOOL_NAME, namespace: null, output: envelope }
      });
      const parsed = z.object({ turn: z.object({ id: Id, status: z.enum(["inProgress", "completed", "interrupted", "failed"]) }) }).parse(result);
      return { turn_id: parsed.turn.id };
    } catch (error) {
      if (error instanceof CodexAppServerTurnStartError && error.effect_state === "not_started") return { rejected: true };
      throw new MessageTransportFailure("offline");
    }
  }

  async readback(grant: CodexTaskMessageGrant, envelope: string, acceptedTurn?: string): Promise<{ turn_id: string; item_id: string } | undefined> {
    const thread = await this.inspect(grant);
    const entries: Array<{ turnId: string; item: unknown }> = [];
    if (thread.historyMode === "paginated") {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 4; page += 1) {
        const result = z.object({
          data: z.array(z.object({ turnId: Id, item: z.unknown() })).max(100),
          nextCursor: z.string().max(2_048).nullable().optional()
        }).parse(await this.request("thread/items/list", {
          threadId: grant.target_id, limit: 100, sortDirection: "desc",
          ...(acceptedTurn ? { turnId: acceptedTurn } : {}), ...(cursor ? { cursor } : {})
        }));
        entries.push(...result.data);
        if (!result.nextCursor) break;
        if (seen.has(result.nextCursor)) throw new MessageTransportFailure("readback_unavailable");
        seen.add(result.nextCursor); cursor = result.nextCursor;
        if (page === 3) throw new MessageTransportFailure("readback_unavailable");
      }
    } else {
      const result = z.object({ thread: Thread.extend({ turns: z.array(z.object({ id: Id, items: z.array(z.unknown()).max(1_000) })).max(1_000) }) })
        .parse(await this.request("thread/read", { threadId: grant.target_id, includeTurns: true }));
      // Recheck the identity of the actual history response, not only the prior summary.
      for (const key of ["id", "sessionId", "cwd", "projectId", "createdAt", "modelProvider", "source"] as const) {
        if (result.thread[key] !== thread[key]) throw new MessageTransportFailure("binding_mismatch");
      }
      for (const turn of result.thread.turns) for (const item of turn.items) entries.push({ turnId: turn.id, item });
    }
    const expected = JSON.parse(envelope) as { message_key: string };
    const matches: Array<{ turn_id: string; item_id: string }> = [];
    for (const { turnId, item } of entries) {
      const parsed = z.object({ type: z.literal("functionCallOutput"), id: Id, name: z.literal(FORWARDING_TOOL_NAME), namespace: z.null().optional(), output: z.string() }).safeParse(item);
      if (!parsed.success) continue;
      let output: unknown;
      try { output = JSON.parse(parsed.data.output); } catch { continue; }
      if (!output || typeof output !== "object" || !("message_key" in output) || output.message_key !== expected.message_key) continue;
      if (parsed.data.output !== envelope || (acceptedTurn && acceptedTurn !== turnId)) throw new MessageTransportFailure("readback_mismatch");
      matches.push({ turn_id: turnId, item_id: parsed.data.id });
    }
    if (matches.length > 1) throw new MessageTransportFailure("readback_mismatch");
    return matches[0];
  }

  private async request(method: "thread/read" | "thread/items/list" | "turn/start", params: Record<string, unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.rpc.request(method, params), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MessageTransportFailure("offline")), this.timeoutMs);
      })]);
    } catch (error) {
      if (error instanceof CodexAppServerTurnStartError) throw error;
      throw new MessageTransportFailure("offline");
    } finally { if (timer) clearTimeout(timer); }
  }
}

export function privateReference(id: string): string { return canonicalSha256({ id }); }
