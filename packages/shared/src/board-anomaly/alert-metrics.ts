import type {
  BoardObservation,
  BoardObservationScored,
  BoardShockEvidence,
  BoardShockMissingNote,
} from "@signal-console/domain";

export function observationTimestampMs(observation: BoardObservation): number {
  const eventTs = Date.parse(observation.eventTimestamp);
  if (Number.isFinite(eventTs)) return eventTs;
  return Date.parse(observation.capturedAt);
}

export function withinShockWindow(
  observation: BoardObservation,
  nowMs: number,
  windowMs: number
): boolean {
  const ts = observationTimestampMs(observation);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= windowMs && ts <= nowMs;
}

export function averageContribution(
  participants: BoardObservationScored[]
): number {
  if (participants.length === 0) return 0;
  const sum = participants.reduce(
    (total, item) => total + item.contribution,
    0
  );
  return sum / participants.length;
}

export function averageMicrostructure(
  participants: BoardObservationScored[]
): number {
  if (participants.length === 0) return 0;
  return (
    participants.reduce((sum, participant) => {
      const components = [
        participant.microstructure.crossVenue,
        participant.microstructure.liquidity,
        participant.microstructure.offPrice,
        participant.microstructure.volatility,
        participant.microstructure.volumeShare,
      ];
      const active = components.filter((value) => value > 0).length;
      if (active === 0) return sum;
      const componentSum = components.reduce((a, b) => a + b, 0);
      return sum + componentSum / active;
    }, 0) / participants.length
  );
}

export function coverageRatio(participants: BoardObservationScored[]): number {
  if (participants.length === 0) return 0;
  return (
    participants.filter(
      (participant) =>
        participant.observation.flags.isStale ||
        participant.observation.missing.impliedProbability ||
        participant.observation.mappingStatus === "unmapped"
    ).length / participants.length
  );
}

export function unmappedRatio(participants: BoardObservationScored[]): number {
  if (participants.length === 0) return 0;
  return (
    participants.filter(
      (participant) =>
        participant.observation.mappingStatus === "unmapped" ||
        participant.observation.flags.isUnmapped
    ).length / participants.length
  );
}

export function firstPopAtFromScored(
  participants: BoardObservationScored[],
  fallbackIso: string
): string {
  const sorted = [...participants].sort(
    (a, b) =>
      observationTimestampMs(a.observation) -
      observationTimestampMs(b.observation)
  );
  return (
    sorted[0]?.observation.eventTimestamp ??
    sorted[0]?.observation.capturedAt ??
    fallbackIso
  );
}

export function evidenceFromScored(
  participants: BoardObservationScored[],
  limit = 8
): BoardShockEvidence[] {
  return participants
    .slice()
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, limit)
    .map((participant) => ({
      observationId: participant.observation.observationId,
      source: participant.observation.source,
      sourceKind: participant.observation.sourceKind,
      family: participant.observation.family,
      participantKey: participant.observation.participantKey,
      displayLabel: participant.observation.displayLabel,
      contribution: Number(participant.contribution.toFixed(3)),
      reason: participant.reason,
      evidenceUnmapped:
        participant.observation.mappingStatus === "unmapped" ||
        participant.observation.flags.isUnmapped,
    }));
}

export function missingDataNotesFromScored(
  participants: BoardObservationScored[]
): BoardShockMissingNote[] {
  const missingDataNotes: BoardShockMissingNote[] = [];
  const seenMissing = new Set<string>();
  for (const participant of participants) {
    const reasons: string[] = [];
    if (participant.observation.flags.isStale) reasons.push("stale quote");
    if (participant.observation.missing.impliedProbability)
      reasons.push("missing implied probability");
    if (participant.observation.missing.volume) reasons.push("missing volume");
    if (
      participant.observation.missing.bestBid ||
      participant.observation.missing.bestAsk
    )
      reasons.push("missing bid/ask");
    if (participant.observation.mappingStatus === "unmapped")
      reasons.push("unmapped market");
    if (reasons.length === 0) continue;
    const key = `${participant.observation.source}:${reasons.join("|")}`;
    if (seenMissing.has(key)) continue;
    seenMissing.add(key);
    missingDataNotes.push({
      source: participant.observation.source,
      reason: reasons.join("; "),
    });
  }
  return missingDataNotes;
}

export function h0DriversFromScored(
  participants: BoardObservationScored[]
): string[] {
  return Array.from(
    new Set(
      participants
        .map((participant) => participant.h0Adjustment.reason)
        .filter((value) => value && value !== "H0 baseline")
    )
  );
}

export function averageH0Suppression(
  participants: BoardObservationScored[]
): number {
  if (participants.length === 0) return 0;
  return (
    participants.reduce(
      (sum, participant) => sum + participant.h0Suppressed,
      0
    ) / participants.length
  );
}

export function instrumentIdsFromScored(
  participants: BoardObservationScored[]
): string[] {
  return Array.from(
    new Set(
      participants
        .map((participant) => participant.observation.instrumentId ?? null)
        .filter((value): value is string => typeof value === "string")
    )
  );
}

export function sourceMarketIdsFromScored(
  participants: BoardObservationScored[]
): string[] {
  return Array.from(
    new Set(
      participants.map((participant) => participant.observation.sourceMarketId)
    )
  );
}
