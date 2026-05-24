import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const BUGFIX_CONCRETE_PATTERNS = [
  /\bwon't\s+(?:load|work|render|start|save|open)\b/i,
  /\bdoesn't\s+(?:load|work|render|start|save|open)\b/i,
  /\bnot\s+(?:loading|working|rendering|saving|starting)\b/i,
  /\bbroken\b/i,
  /\bregression\b/i,
  /\bdefect\b/i,
  /\bfailing\b/i,
  /\bfailure\b/i,
  /\bcrash(?:ing)?\b/i,
  /\berror\b/i,
  /\brace condition\b/i,
  /\bstuck\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bfix\b.{0,40}\b(?:bug|loading|render|state|error|crash|issue|failure)\b/i,
];

const BUGFIX_META_PATTERNS = [
  /\bhook(?:s)?\b/i,
  /\bskill(?:s)?\b/i,
  /\bpolicy\b/i,
  /\brule(?:s)?\b/i,
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\bconfig(?:uration)?\b/i,
  /\bagents\.md\b/i,
  /\bdeveloper docs\b/i,
];

const TEST_FILE_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)tests\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];

const TEST_COMMAND_PATTERNS = [
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bplaywright\b/i,
  /\bcypress\b/i,
  /\bmocha\b/i,
  /\bava\b/i,
  /\bpnpm\b.*\btest(?::[\w-]+)?\b/i,
  /\bnpm\b.*\btest(?::[\w-]+)?\b/i,
  /\byarn\b.*\btest(?::[\w-]+)?\b/i,
  /\bbun\b.*\btest(?::[\w-]+)?\b/i,
];

const VERIFY_COMMAND_PATTERNS = [
  /\bpnpm\s+verify\b/i,
  /\bnpm\s+run\s+verify\b/i,
  /\byarn\s+verify\b/i,
  /\bbun\s+run\s+verify\b/i,
];

export interface HookPersistenceOptions {
  repoRootResolver?: (cwd: string) => string;
  stateRoot?: string;
}

export interface HookCommandAttempt {
  command: string;
  exitCode: number | null;
}

export interface RegressionTurnState {
  version: 1;
  bugfixRequired: boolean;
  editedFiles: string[];
  editedNonTestFiles: string[];
  prompt: string;
  sawEdit: boolean;
  testCommandAttempts: HookCommandAttempt[];
  touchedTestFiles: string[];
  turnId: string;
  verifyCommandAttempts: HookCommandAttempt[];
}

export interface UserPromptSubmitInput {
  cwd: string;
  prompt: string;
  session_id: string;
  turn_id: string;
}

export interface PostToolUseInput {
  cwd: string;
  session_id: string;
  tool_input?: unknown;
  tool_name: string;
  tool_response?: unknown;
  turn_id: string;
}

export interface StopHookInput {
  cwd: string;
  last_assistant_message?: string | null;
  session_id: string;
  stop_hook_active?: boolean;
  turn_id: string;
}

interface HookOutput {
  continue?: boolean;
  decision?: "block";
  hookSpecificOutput?: {
    additionalContext?: string;
    hookEventName: "UserPromptSubmit";
  };
  reason?: string;
  stopReason?: string;
  systemMessage?: string;
}

function buildEmptyState(
  input: Pick<UserPromptSubmitInput, "prompt" | "turn_id">
): RegressionTurnState {
  return {
    version: 1,
    bugfixRequired: false,
    editedFiles: [],
    editedNonTestFiles: [],
    prompt: input.prompt,
    sawEdit: false,
    testCommandAttempts: [],
    touchedTestFiles: [],
    turnId: input.turn_id,
    verifyCommandAttempts: [],
  };
}

export function buildBugfixPolicyContext(): string {
  return [
    "Bug-fix regression rule:",
    "after resolving a defect, add or update tests at the affected observable boundary.",
    "The required test should cover the broken contract, feature behavior, integration path, or system invariant.",
    "Do not satisfy this with a narrow white-box test tied only to the edited helper, function, or module.",
    "Before ending the turn, run at least one changed-surface test command and the repo standard verify command.",
  ].join(" ");
}

export function detectBugfixIntent(prompt: string): boolean {
  const hasConcreteSignal = BUGFIX_CONCRETE_PATTERNS.some((pattern) =>
    pattern.test(prompt)
  );
  if (!hasConcreteSignal) {
    return false;
  }
  const hasMetaSignal = BUGFIX_META_PATTERNS.some((pattern) =>
    pattern.test(prompt)
  );
  return !hasMetaSignal;
}

export function extractPatchedFiles(command: string): string[] {
  const files = new Set<string>();
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /^\*\*\* Move to: (.+)$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const filePath = match[1]?.trim();
      if (filePath) {
        files.add(filePath);
      }
    }
  }
  return [...files];
}

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyBashCommand(command: string): {
  isTestCommand: boolean;
  isVerifyCommand: boolean;
} {
  return {
    isTestCommand: TEST_COMMAND_PATTERNS.some((pattern) =>
      pattern.test(command)
    ),
    isVerifyCommand: VERIFY_COMMAND_PATTERNS.some((pattern) =>
      pattern.test(command)
    ),
  };
}

function slugPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveRepoRoot(
  cwd: string,
  repoRootResolver?: HookPersistenceOptions["repoRootResolver"]
): string {
  if (repoRootResolver) {
    return repoRootResolver(cwd);
  }
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

function resolveStateRoot(options?: HookPersistenceOptions): string {
  if (options?.stateRoot) {
    return options.stateRoot;
  }
  return path.join(
    homedir(),
    ".codex",
    "hook-state",
    "bugfix-regression-guard"
  );
}

function resolveStatePath(
  input: Pick<UserPromptSubmitInput, "cwd" | "session_id" | "turn_id">,
  options?: HookPersistenceOptions
): string {
  const repoRoot = resolveRepoRoot(input.cwd, options?.repoRootResolver);
  return path.join(
    resolveStateRoot(options),
    slugPath(repoRoot),
    slugPath(input.session_id),
    `${slugPath(input.turn_id)}.json`
  );
}

function readState(
  input: Pick<
    UserPromptSubmitInput,
    "cwd" | "prompt" | "session_id" | "turn_id"
  >,
  options?: HookPersistenceOptions
): RegressionTurnState {
  const statePath = resolveStatePath(input, options);
  if (!existsSync(statePath)) {
    return buildEmptyState(input);
  }
  try {
    const parsed = JSON.parse(
      readFileSync(statePath, "utf8")
    ) as RegressionTurnState;
    return {
      ...buildEmptyState(input),
      ...parsed,
      prompt: parsed.prompt || input.prompt,
      turnId: parsed.turnId || input.turn_id,
    };
  } catch {
    return buildEmptyState(input);
  }
}

function writeState(
  input: Pick<UserPromptSubmitInput, "cwd" | "session_id" | "turn_id">,
  state: RegressionTurnState,
  options?: HookPersistenceOptions
): void {
  const statePath = resolveStatePath(input, options);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function deleteState(
  input: Pick<UserPromptSubmitInput, "cwd" | "session_id" | "turn_id">,
  options?: HookPersistenceOptions
): void {
  const statePath = resolveStatePath(input, options);
  if (existsSync(statePath)) {
    rmSync(statePath);
  }
}

function pushUnique(values: string[], nextValue: string): string[] {
  return values.includes(nextValue) ? values : [...values, nextValue];
}

function extractCommandInput(toolInput: unknown): string | null {
  if (
    typeof toolInput === "object" &&
    toolInput !== null &&
    "command" in toolInput &&
    typeof (toolInput as { command?: unknown }).command === "string"
  ) {
    return (toolInput as { command: string }).command;
  }
  return null;
}

function extractExitCode(toolResponse: unknown): number | null {
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return null;
  }
  const candidate = toolResponse as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode", "code", "status"]) {
    if (typeof candidate[key] === "number") {
      return candidate[key] as number;
    }
  }
  return null;
}

function updateStateFromPatch(
  state: RegressionTurnState,
  patchCommand: string
): RegressionTurnState {
  const files = extractPatchedFiles(patchCommand);
  let nextState = { ...state, sawEdit: state.sawEdit || files.length > 0 };
  for (const filePath of files) {
    nextState = {
      ...nextState,
      editedFiles: pushUnique(nextState.editedFiles, filePath),
    };
    if (isTestPath(filePath)) {
      nextState = {
        ...nextState,
        touchedTestFiles: pushUnique(nextState.touchedTestFiles, filePath),
      };
      continue;
    }
    nextState = {
      ...nextState,
      editedNonTestFiles: pushUnique(nextState.editedNonTestFiles, filePath),
    };
  }
  return nextState;
}

function updateStateFromBash(
  state: RegressionTurnState,
  command: string,
  exitCode: number | null
): RegressionTurnState {
  const classification = classifyBashCommand(command);
  let nextState = { ...state };
  if (classification.isTestCommand) {
    nextState = {
      ...nextState,
      testCommandAttempts: [
        ...nextState.testCommandAttempts,
        { command, exitCode },
      ],
    };
  }
  if (classification.isVerifyCommand) {
    nextState = {
      ...nextState,
      verifyCommandAttempts: [
        ...nextState.verifyCommandAttempts,
        { command, exitCode },
      ],
    };
  }
  return nextState;
}

function summarizeMissingCoverage(state: RegressionTurnState): string[] {
  const missing: string[] = [];
  if (state.touchedTestFiles.length === 0) {
    missing.push(
      "add or update a behavior-level regression test for the broken behavior"
    );
  }
  if (state.testCommandAttempts.length === 0) {
    missing.push("run at least one changed-surface test command");
  }
  if (state.verifyCommandAttempts.length === 0) {
    missing.push("run `pnpm verify`");
  }
  return missing;
}

function shouldGateStop(state: RegressionTurnState): boolean {
  return (
    state.bugfixRequired && state.sawEdit && state.editedNonTestFiles.length > 0
  );
}

function buildStopReason(missing: string[]): string {
  return [
    "Regression coverage gate:",
    missing.join("; "),
    "Remember: the regression test must protect the observable contract or feature behavior, not just the edited helper.",
  ].join(" ");
}

export function applyUserPromptEvent(
  input: UserPromptSubmitInput,
  options?: HookPersistenceOptions
): HookOutput | null {
  const state = buildEmptyState(input);
  state.bugfixRequired = detectBugfixIntent(input.prompt);
  writeState(input, state, options);
  if (!state.bugfixRequired) {
    return null;
  }
  return {
    hookSpecificOutput: {
      additionalContext: buildBugfixPolicyContext(),
      hookEventName: "UserPromptSubmit",
    },
  };
}

export function applyPostToolUseEvent(
  input: PostToolUseInput,
  options?: HookPersistenceOptions
): void {
  const state = readState(
    {
      cwd: input.cwd,
      prompt: "",
      session_id: input.session_id,
      turn_id: input.turn_id,
    },
    options
  );
  let nextState = { ...state };
  if (input.tool_name === "apply_patch") {
    const patchCommand = extractCommandInput(input.tool_input);
    if (patchCommand) {
      nextState = updateStateFromPatch(nextState, patchCommand);
    }
  }
  if (input.tool_name === "Bash") {
    const command = extractCommandInput(input.tool_input);
    if (command) {
      nextState = updateStateFromBash(
        nextState,
        command,
        extractExitCode(input.tool_response)
      );
    }
  }
  writeState(
    {
      cwd: input.cwd,
      session_id: input.session_id,
      turn_id: input.turn_id,
    },
    nextState,
    options
  );
}

export function applyStopEvent(
  input: StopHookInput,
  options?: HookPersistenceOptions
): HookOutput | null {
  const state = readState(
    {
      cwd: input.cwd,
      prompt: "",
      session_id: input.session_id,
      turn_id: input.turn_id,
    },
    options
  );
  if (!shouldGateStop(state)) {
    deleteState(
      {
        cwd: input.cwd,
        session_id: input.session_id,
        turn_id: input.turn_id,
      },
      options
    );
    return null;
  }
  const missing = summarizeMissingCoverage(state);
  if (missing.length === 0) {
    deleteState(
      {
        cwd: input.cwd,
        session_id: input.session_id,
        turn_id: input.turn_id,
      },
      options
    );
    return null;
  }
  const reason = buildStopReason(missing);
  if (input.stop_hook_active) {
    return {
      continue: false,
      stopReason: reason,
      systemMessage: reason,
    };
  }
  return {
    decision: "block",
    reason,
  };
}

async function readStdinJson(): Promise<unknown> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!mode) {
    throw new Error("expected hook mode");
  }
  const payload = (await readStdinJson()) as
    | UserPromptSubmitInput
    | PostToolUseInput
    | StopHookInput;

  let output: HookOutput | null = null;

  if (mode === "user-prompt-submit") {
    output = applyUserPromptEvent(payload as UserPromptSubmitInput);
  } else if (mode === "post-tool-use") {
    applyPostToolUseEvent(payload as PostToolUseInput);
  } else if (mode === "stop") {
    output = applyStopEvent(payload as StopHookInput);
  } else {
    throw new Error(`unsupported hook mode: ${mode}`);
  }

  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
