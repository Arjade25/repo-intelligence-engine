import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * Claude Code as the agent under test, shared by benchmarks/run.ts (the original
 * hand-written task sets) and the generated-task harness. Everything here was
 * verified against real transcripts before being relied on - see run.ts's header
 * for the details (tool_use block shape, `--tools` vs `--mcp-config` being
 * separate axes, why `--setting-sources project,local` and not `--bare`).
 */

export const READ_ONLY_TOOLS = "Read,Grep,Glob";
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export interface TranscriptMetrics {
  tool_calls: number;
  tool_calls_by_name: Record<string, number>;
  /** input + output + cache_creation + cache_read, summed over main-thread assistant turns. */
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Every model id seen on an assistant turn - more than one means the run wasn't single-model. */
  models: string[];
}

/**
 * Resolve the `claude` CLI once, up front, so a bad setup fails immediately with
 * an actionable message instead of on run 1 of N. PATH alone is not reliable: an
 * already-open terminal keeps the environment it started with, and a spawn
 * ENOENT otherwise surfaces as the useless "claude exited null: undefined".
 */
export function resolveClaudeBin(): string {
  const override = process.env.RIE_CLAUDE_BIN;
  if (override) {
    if (!existsSync(override)) throw new Error(`RIE_CLAUDE_BIN is set but does not exist: ${override}`);
    return override;
  }

  const onPath = spawnSync("claude", ["--version"], { encoding: "utf8", shell: false });
  if (!onPath.error) return "claude";

  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  if (existsSync(local)) {
    console.log(`note: "claude" is not on this shell's PATH; using ${local}`);
    return local;
  }

  throw new Error(
    `Cannot find the "claude" CLI, which this harness spawns for every run.\n` +
      `  - not on PATH (${(onPath.error as NodeJS.ErrnoException).code})\n` +
      `  - not at ${local}\n` +
      `Fix: open a NEW terminal (an already-open one keeps a stale environment), ` +
      `or set RIE_CLAUDE_BIN to the executable's full path.`
  );
}

/** Locate a run's transcript by the session id we chose ourselves - sidesteps
 *  replicating Claude Code's cwd -> project-directory-name encoding, which was
 *  observed to vary in casing between runs. */
export function findTranscript(sessionId: string): string {
  const projectsDir = join(CLAUDE_CONFIG_DIR, "projects");
  for (const entry of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`transcript not found for session ${sessionId} under ${projectsDir}`);
}

/** Tally tool_use blocks and token usage from assistant turns, skipping subagent sidechains. */
export function parseTranscript(transcriptPath: string): TranscriptMetrics {
  const m: TranscriptMetrics = {
    tool_calls: 0,
    tool_calls_by_name: {},
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    models: [],
  };
  const models = new Set<string>();

  for (const line of readFileSync(transcriptPath, "utf8").trim().split("\n")) {
    let record: {
      type?: string;
      isSidechain?: boolean;
      message?: { model?: string; content?: unknown; usage?: Record<string, number> };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "assistant" || record.isSidechain) continue;
    if (record.message?.model) models.add(record.message.model);

    const usage = record.message?.usage;
    if (usage) {
      m.input_tokens += usage.input_tokens ?? 0;
      m.output_tokens += usage.output_tokens ?? 0;
      m.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
      m.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    }

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; name?: string }[]) {
      if (block.type !== "tool_use") continue;
      m.tool_calls++;
      const name = block.name ?? "?";
      m.tool_calls_by_name[name] = (m.tool_calls_by_name[name] ?? 0) + 1;
    }
  }

  m.total_tokens = m.input_tokens + m.output_tokens + m.cache_creation_input_tokens + m.cache_read_input_tokens;
  m.models = [...models].sort();
  return m;
}

export interface ClaudeRunRequest {
  prompt: string;
  cwd: string;
  /** Omitted for the no-tool baseline. */
  mcpConfigPath?: string;
  model?: string;
  /** Kill the session after this long. Without it one stalled API call hung a run for 66 min. */
  timeoutMs?: number;
  /** Built-in tools for this arm (default READ_ONLY_TOOLS). */
  builtinTools?: string;
  /** Extra environment for the agent process, e.g. config for a CLI the arm provides. */
  env?: Record<string, string>;
  /** Directories put in front of PATH, so an arm's CLI tools resolve by name. */
  pathPrepend?: string[];
  /** Appended to the system prompt: what this arm has, the way MCP tool descriptions tell the rie arm. */
  appendSystemPrompt?: string;
  /**
   * Stop the session after this many turns (claude --max-turns). A runaway guard,
   * not a budget: one element-web baseline session used 74 turns and ~3M tokens.
   * Set it well above normal use, or a tight cap hands the cheaper arm wins it
   * didn't earn.
   */
  maxTurns?: number;
}

export interface ClaudeRunOutput {
  session_id: string;
  final_text: string;
  metrics: TranscriptMetrics;
  wall_ms: number;
  /** From `--output-format json`, when present. Informational: cost depends on cache hits, tokens don't. */
  cost_usd: number | null;
  num_turns: number | null;
  /** True when the session hit maxTurns before answering. */
  capped?: boolean;
}

export function claudeArgs(req: ClaudeRunRequest, sessionId: string): string[] {
  const args = [
    "-p",
    req.prompt,
    "--session-id",
    sessionId,
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    req.builtinTools ?? READ_ONLY_TOOLS,
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
  ];
  if (req.model) args.push("--model", req.model);
  if (req.mcpConfigPath) args.push("--mcp-config", req.mcpConfigPath);
  if (req.appendSystemPrompt) args.push("--append-system-prompt", req.appendSystemPrompt);
  if (req.maxTurns) args.push("--max-turns", String(req.maxTurns));
  return args;
}

/**
 * The agent's environment: ours plus the arm's additions. PATH is matched
 * case-insensitively because Windows calls it Path, and a spread copy of
 * process.env loses the case-insensitive lookup - adding "PATH" next to an
 * existing "Path" leaves two entries and which one wins is unspecified.
 */
export function agentEnv(req: Pick<ClaudeRunRequest, "env" | "pathPrepend">, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...req.env };
  if (req.pathPrepend?.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const sep = process.platform === "win32" ? ";" : ":";
    env[key] = [...req.pathPrepend, env[key]].filter(Boolean).join(sep);
  }
  return env;
}

export function runClaude(claudeBin: string, req: ClaudeRunRequest): ClaudeRunOutput {
  const sessionId = randomUUID();
  const started = Date.now();
  // shell:false is deliberate: shell:true re-splits args without escaping, which
  // silently breaks multi-word prompts into separate argv tokens on Windows.
  const result = spawnSync(claudeBin, claudeArgs(req, sessionId), {
    cwd: req.cwd,
    encoding: "utf8",
    shell: false,
    stdio: "pipe",
    env: agentEnv(req),
    maxBuffer: 64 * 1024 * 1024,
    ...(req.timeoutMs !== undefined && { timeout: req.timeoutMs }),
  });
  const wall_ms = Date.now() - started;

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`session ${sessionId} timed out after ${Math.round(wall_ms / 60_000)} min and was killed`);
  }
  if (result.error) {
    throw new Error(
      `could not spawn "${claudeBin}": ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`
    );
  }
  let parsed: { result?: string; subtype?: string; total_cost_usd?: number; num_turns?: number } = {};
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = { result: result.stdout };
  }
  // Hitting --max-turns exits 1 but still prints the session's JSON (subtype
  // error_max_turns, checked on CLI 2.1.295). It is a finished, paid-for session
  // that gave no answer - a wrong run, not a failed launch for --resume to retry.
  const capped = parsed.subtype === "error_max_turns";
  if (result.status !== 0 && !capped) {
    throw new Error(`claude exited ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}: ${result.stderr || "(no stderr)"}`);
  }

  return {
    session_id: sessionId,
    final_text: parsed.result ?? "",
    metrics: parseTranscript(findTranscript(sessionId)),
    wall_ms,
    cost_usd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    num_turns: typeof parsed.num_turns === "number" ? parsed.num_turns : null,
    ...(capped && { capped: true }),
  };
}
