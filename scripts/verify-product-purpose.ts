import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PRODUCT_PURPOSE_BLOCK = `# Signal Console Core Purpose

Signal Console is for one expensive NBA trading problem: a live data feed can credit the wrong player, or correct a play later, while player props and game props are still being priced. A rebound, assist, block, or point can land under the wrong name, and exposed markets may keep trading against that bad state. Signal Console watches market movement around those moments so bet365 can review or suspend affected markets before bad trades turn into bad payouts.

The mistake rarely stays inside one bet. If a rebound is credited to the wrong player, it can touch that player's props, the player who should have received credit, combo markets, team rebounds, quarter markets, and game-level prices. Sometimes the official correction arrives late. Sometimes it never arrives in a way that changes settlement. The useful warning is simpler: the board is behaving as if something around the play deserves a closer look.

`;

export interface CheckedFile {
  readonly absolutePath: string;
  readonly label: string;
  readonly required: boolean;
}

const ROOT = resolve(import.meta.dirname, "..");

function projectSlug(root: string): string {
  return root.replaceAll("/", "-");
}

function repoFile(root: string, relativePath: string): CheckedFile {
  return {
    absolutePath: resolve(root, relativePath),
    label: relativePath,
    required: true,
  };
}

export interface VerifyProductPurposeOptions {
  readonly projectMemoryPath?: string;
  readonly root?: string;
}

export interface VerifyProductPurposeResult {
  readonly checkedFiles: readonly CheckedFile[];
  readonly violations: readonly string[];
}

export function productPurposeCheckedFiles(
  root: string = ROOT,
  projectMemoryPath: string = join(homedir(), ".codex", "projects", projectSlug(root), "MEMORY.md"),
): readonly CheckedFile[] {
  return [
    repoFile(root, "AGENTS.md"),
    repoFile(root, "CLAUDE.md"),
    repoFile(root, ".codex/memory.md"),
    repoFile(root, "scripts/ralph/CLAUDE.md"),
    {
      absolutePath: projectMemoryPath,
      label: `~/.codex/projects/${projectSlug(root)}/MEMORY.md`,
      required: false,
    },
  ];
}

export function verifyProductPurpose(
  options: VerifyProductPurposeOptions = {},
): VerifyProductPurposeResult {
  const root = options.root ?? ROOT;
  const checkedFiles = productPurposeCheckedFiles(root, options.projectMemoryPath);
  const violations = checkedFiles.flatMap((file): readonly string[] => {
    if (!existsSync(file.absolutePath)) {
      return file.required ? [`${file.label}: required product-purpose file is missing`] : [];
    }

    const contents = readFileSync(file.absolutePath, "utf8");
    return contents.startsWith(PRODUCT_PURPOSE_BLOCK)
      ? []
      : [`${file.label}: must start with Signal Console Core Purpose`];
  });

  return { checkedFiles, violations };
}

function isEntrypoint(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

function main(): number {
  const result = verifyProductPurpose();
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(violation);
    }
    console.error(
      `verify:product-purpose FAILED (${String(result.violations.length)} violation(s))`,
    );
    return 1;
  }

  console.log("verify:product-purpose OK");
  return 0;
}

if (isEntrypoint()) {
  process.exit(main());
}
