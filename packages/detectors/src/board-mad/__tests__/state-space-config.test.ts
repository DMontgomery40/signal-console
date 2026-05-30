import { describe, expect, it } from "vitest";

import {
  BOARD_STATE_SPACE_CONFIG_DEFAULTS,
  BoardStateSpaceConfigSchema,
} from "../state-space-config";

describe("BoardStateSpaceConfigSchema scale ordering", () => {
  it("accepts the packaged defaults (scaleFloor <= scaleCeiling)", () => {
    const parsed = BoardStateSpaceConfigSchema.parse(BOARD_STATE_SPACE_CONFIG_DEFAULTS);
    expect(parsed.scale.scaleFloor).toBeLessThanOrEqual(parsed.scale.scaleCeiling);
  });

  it("accepts scaleFloor equal to scaleCeiling", () => {
    const parsed = BoardStateSpaceConfigSchema.parse({
      scale: { ...BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale, scaleFloor: 1, scaleCeiling: 1 },
    });
    expect(parsed.scale.scaleFloor).toBe(1);
    expect(parsed.scale.scaleCeiling).toBe(1);
  });

  it("rejects scaleFloor greater than scaleCeiling", () => {
    const result = BoardStateSpaceConfigSchema.safeParse({
      scale: { ...BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale, scaleFloor: 4, scaleCeiling: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (entry) => entry.path.join(".") === "scale.scaleFloor",
      );
      expect(issue?.message).toContain("scaleCeiling");
    }
  });
});
