import type {
  BoardAnomalyAlert,
  MarketAnomalyAlert,
  MarketFamily,
} from "@signal-console/domain";

import { scoreToSeverity } from "./board-anomaly/config";
import {
  formatNumber,
  participantKeyFromDisplayLabel,
  statFamilyFromLabel,
  titleCase,
} from "./board-anomaly-fanout-support";
import {
  classifyPlayByPlayAnchorTiming,
  type PlayByPlayContext,
} from "./board-anomaly-play-by-play";
import { sourceKindFor } from "./board-anomaly-support";

import type { FinishedGameIncident } from "./board-anomaly-incidents";

function buildMarketStructureReason(alert: MarketAnomalyAlert): string {
  const parts: string[] = [];
  parts.push(`${alert.displayLabel} (${alert.source})`);
  const m = alert.metrics;
  const isPredictionMarket =
    sourceKindFor(alert.source) === "prediction-market";
  if (m.tradePrice != null) {
    const note =
      m.referencePrice != null
        ? ` vs reference ${formatNumber(m.referencePrice, 3)} (off-price ${formatNumber(m.tradeDistance, 3)})`
        : "";
    parts.push(`trade ${formatNumber(m.tradePrice, 3)}${note}`);
  }
  if (m.size != null) {
    parts.push(`size ${formatNumber(m.size, 2)}`);
  }
  if (m.notional != null) {
    parts.push(`notional $${formatNumber(m.notional, 2)}`);
  }
  if (m.volumeShare != null) {
    const shareSource =
      m.finalMarketVolume != null ? "FINAL-volume (forensic)" : "live-to-date";
    parts.push(
      `${(m.volumeShare * 100).toFixed(1)}% volume share [${shareSource}]`
    );
  }
  if (m.spread != null && isPredictionMarket) {
    parts.push(`spread ${formatNumber(m.spread, 3)}`);
  }
  const labels = alert.labels.length > 0 ? ` · ${alert.labels.join(", ")}` : "";
  return `${parts.join(" · ")}${labels}.`;
}

type FanoutCandidate = {
  alert: MarketAnomalyAlert;
  family: string | null;
  participantKey: string | null;
  ts: number;
};

type Fanout = {
  gameId: string;
  gameLabel: string;
  participantKey: string;
  windowStartIso: string;
  windowEndIso: string;
  primaryAlert: MarketAnomalyAlert;
  members: FanoutCandidate[];
  pairedParticipants: Map<string, FanoutCandidate[]>;
};

function fanoutShockKind(
  anchorAt: string,
  pbp: PlayByPlayContext
): BoardAnomalyAlert["shockKind"] {
  const timing = classifyPlayByPlayAnchorTiming(anchorAt, pbp);
  if (timing === "near-tip") return "near-tip-availability";
  if (timing === "pregame") return "pregame-availability";
  return "attribution-shaped";
}

export function buildFanouts(
  marketAnomalies: MarketAnomalyAlert[],
  windowSeconds = 120,
  minStatFamilies = 2,
  minVolumeShare = 0.1
) {
  const candidates: FanoutCandidate[] = marketAnomalies
    .filter((alert) => (alert.metrics.volumeShare ?? 0) >= minVolumeShare)
    .map((alert) => ({
      alert,
      family: statFamilyFromLabel(alert.displayLabel),
      participantKey: participantKeyFromDisplayLabel(alert.displayLabel),
      ts: Date.parse(alert.eventTimestamp),
    }))
    .filter(
      (entry) => entry.participantKey != null && Number.isFinite(entry.ts)
    );

  const byGame = new Map<string, FanoutCandidate[]>();
  for (const candidate of candidates) {
    const list = byGame.get(candidate.alert.gameId) ?? [];
    list.push(candidate);
    byGame.set(candidate.alert.gameId, list);
  }

  const fanouts: Fanout[] = [];
  for (const [gameId, list] of byGame.entries()) {
    list.sort((a, b) => a.ts - b.ts);
    const used = new Set<string>();
    for (let i = 0; i < list.length; i += 1) {
      if (used.has(list[i].alert.id)) continue;
      const anchor = list[i];
      if (!anchor.participantKey) continue;
      const cluster: FanoutCandidate[] = [anchor];
      const familySet = new Set<string>([anchor.family ?? "other"]);
      const windowMs = windowSeconds * 1000;
      for (let j = i + 1; j < list.length; j += 1) {
        if (used.has(list[j].alert.id)) continue;
        const candidate = list[j];
        if (candidate.ts - anchor.ts > windowMs) break;
        if (candidate.participantKey === anchor.participantKey) {
          cluster.push(candidate);
          familySet.add(candidate.family ?? "other");
        }
      }
      if (familySet.size < minStatFamilies) continue;
      for (const member of cluster) used.add(member.alert.id);
      const paired = new Map<string, FanoutCandidate[]>();
      for (const other of list) {
        if (used.has(other.alert.id)) continue;
        if (
          other.participantKey &&
          other.participantKey !== anchor.participantKey &&
          Math.abs(other.ts - anchor.ts) <= windowMs * 2
        ) {
          const bucket = paired.get(other.participantKey) ?? [];
          bucket.push(other);
          paired.set(other.participantKey, bucket);
        }
      }
      const sorted = cluster.slice().sort((a, b) => a.ts - b.ts);
      fanouts.push({
        gameId,
        gameLabel: anchor.alert.gameLabel,
        participantKey: anchor.participantKey,
        windowStartIso: sorted[0].alert.eventTimestamp,
        windowEndIso: sorted[sorted.length - 1].alert.eventTimestamp,
        primaryAlert: cluster.reduce((best, member) =>
          (member.alert.metrics.volumeShare ?? 0) >
          (best.alert.metrics.volumeShare ?? 0)
            ? member
            : best
        ).alert,
        members: cluster,
        pairedParticipants: paired,
      });
    }
  }
  return fanouts;
}

function buildFanoutReason(fanout: Fanout): string {
  const playerLabel = titleCase(fanout.participantKey);
  const familyTopShare = new Map<string, number>();
  for (const member of fanout.members) {
    const family = member.family ?? "other";
    const share = member.alert.metrics.volumeShare ?? 0;
    familyTopShare.set(
      family,
      Math.max(familyTopShare.get(family) ?? 0, share)
    );
  }
  const familyParts = Array.from(familyTopShare.entries())
    .sort((a, b) => b[1] - a[1])
    .map(
      ([family, share]) =>
        `${family} (top ${(share * 100).toFixed(0)}% volume share)`
    )
    .join(", ");
  const durationMs =
    Date.parse(fanout.windowEndIso) - Date.parse(fanout.windowStartIso);
  const durationText =
    durationMs < 1000
      ? "same second"
      : durationMs < 60_000
        ? `${Math.round(durationMs / 1000)}s`
        : `${Math.round(durationMs / 60_000)}m`;
  const pairedSummary =
    fanout.pairedParticipants.size > 0
      ? ` Other player markets moved alongside: ${Array.from(
          fanout.pairedParticipants.keys()
        )
          .slice(0, 3)
          .map(titleCase)
          .join(", ")}.`
      : "";
  return `Movement is concentrated around ${playerLabel}'s ${familyParts} within ${durationText}.${pairedSummary} Pattern is consistent with an in-game stat event affecting ${playerLabel}.`;
}

export function fanoutToBoardCard(
  fanout: ReturnType<typeof buildFanouts>[number],
  pbp: PlayByPlayContext
): FinishedGameIncident {
  const primary = fanout.primaryAlert;
  const peakShare = Math.max(
    ...fanout.members.map((m) => m.alert.metrics.volumeShare ?? 0)
  );
  const totalNotional = fanout.members.reduce(
    (sum, m) => sum + (m.alert.metrics.notional ?? 0),
    0
  );
  const peakScore = Math.max(...fanout.members.map((m) => m.alert.score));
  const score = Math.min(
    100,
    Math.round(peakScore + fanout.members.length * 3)
  );
  const confidence = Math.min(
    0.97,
    0.6 + peakShare * 0.3 + fanout.members.length * 0.03
  );
  const shockKind = fanoutShockKind(fanout.windowStartIso, pbp);
  const reason =
    shockKind === "attribution-shaped"
      ? buildFanoutReason(fanout)
      : `Movement is concentrated around ${titleCase(
          fanout.participantKey
        )}'s related props before tip. Treat this as a player-specific availability/timing tripwire until an in-game NBA row confirms the underlying event.`;
  const evidence: BoardAnomalyAlert["evidence"] = fanout.members
    .slice()
    .sort(
      (a, b) =>
        (b.alert.metrics.volumeShare ?? 0) - (a.alert.metrics.volumeShare ?? 0)
    )
    .slice(0, 8)
    .map((member) => ({
      observationId: `fanout:${member.alert.id}`,
      source: member.alert.source,
      sourceKind: sourceKindFor(member.alert.source),
      family: member.alert.family ?? null,
      participantKey: fanout.participantKey,
      displayLabel: member.alert.displayLabel,
      contribution: Number(
        Math.min(1, member.alert.metrics.volumeShare ?? 0).toFixed(3)
      ),
      reason: `${((member.alert.metrics.volumeShare ?? 0) * 100).toFixed(1)}% share · $${(member.alert.metrics.notional ?? 0).toFixed(0)} @ $${(member.alert.metrics.tradePrice ?? 0).toFixed(2)}`,
      evidenceUnmapped: member.alert.mappingStatus === "unmapped",
    }));

  const drivers: string[] = [];
  if (!pbp.available) {
    drivers.push("persisted NBA play-by-play missing for this game snapshot");
  }
  drivers.push(
    `${fanout.members.length} ${titleCase(fanout.participantKey)} props moved within window`
  );
  if (fanout.pairedParticipants.size > 0) {
    drivers.push(
      `${fanout.pairedParticipants.size} paired-player marker(s) in surrounding window`
    );
  }

  return {
    id: `fanout:${fanout.gameId}:${fanout.participantKey}:${fanout.windowStartIso}`,
    gameId: fanout.gameId,
    gameLabel: fanout.gameLabel,
    shockKind,
    firstPopAt: fanout.windowStartIso,
    detectedAt: fanout.windowStartIso,
    score,
    confidence: Number(confidence.toFixed(3)),
    severity: scoreToSeverity(score),
    reason,
    primaryEntityKey: fanout.participantKey,
    primaryFamily: (primary.family ?? null) as MarketFamily | null,
    components: {
      residual: Number(Math.min(1, peakShare * 2).toFixed(3)),
      microstructure: Number(Math.min(1, totalNotional / 200).toFixed(3)),
      coherence: Number(Math.min(1, fanout.members.length / 4).toFixed(3)),
      coverage: pbp.available ? 0 : 1,
    },
    h0Adjustments: {
      appliedSuppression: 0,
      drivers,
    },
    evidence,
    missingDataNotes: pbp.available
      ? []
      : [
          {
            source: "nba",
            reason:
              "persisted NBA play-by-play missing for this snapshot — cannot confirm stat event directly",
          },
        ],
    inspect: {
      payloadVersion: 1,
      instrumentIds: fanout.members
        .map((m) => m.alert.instrumentId)
        .filter((id): id is string => typeof id === "string"),
      sourceMarketIds: fanout.members.map((m) => m.alert.sourceMarketId),
      relationFamilies: Array.from(
        new Set(fanout.members.map((m) => m.family ?? "other"))
      ),
    },
    playByPlay: pbp,
    vigAdjusted: null,
  };
}

export function marketAnomalyToBoardCard(
  alert: MarketAnomalyAlert,
  pbp: PlayByPlayContext,
  candleEnd: boolean
): FinishedGameIncident {
  const surface = alert.apiSurface.toLowerCase();
  const isCandle = candleEnd || surface.includes("candle");
  const primaryEntityKey =
    alert.family === "player-prop" || alert.family === "team-prop"
      ? participantKeyFromDisplayLabel(alert.displayLabel)
      : null;
  const evidence = [
    {
      observationId: `microstructure:${alert.id}`,
      source: alert.source,
      sourceKind: sourceKindFor(alert.source),
      family: alert.family ?? null,
      participantKey: null,
      displayLabel: alert.displayLabel,
      contribution: Number((alert.score / 100).toFixed(3)),
      reason: alert.labels.join(", ") || alert.apiSurface,
      evidenceUnmapped: alert.mappingStatus === "unmapped",
    },
  ];

  const drivers: string[] = [];
  if (isCandle) {
    drivers.push("candle-end, not executable");
  }
  if (alert.metrics.finalMarketVolume != null) {
    drivers.push(
      "volume-share computed against FINAL market volume (forensic, not live)"
    );
  }
  if (!pbp.available) {
    drivers.push("persisted NBA play-by-play missing for this snapshot");
  }

  return {
    id: `incident:${alert.gameId}:market-structure:${alert.id}`,
    gameId: alert.gameId,
    gameLabel: alert.gameLabel,
    shockKind: "market-structure",
    firstPopAt: alert.eventTimestamp,
    detectedAt: alert.eventTimestamp,
    score: alert.score,
    confidence: alert.confidence,
    severity: alert.severity,
    reason: buildMarketStructureReason(alert),
    primaryEntityKey,
    primaryFamily: (alert.family ?? null) as MarketFamily | null,
    components: {
      residual: Number(
        ((alert.components.offPrice + alert.components.volatility) / 2).toFixed(
          3
        )
      ),
      microstructure: Number(
        (
          (alert.components.crossVenue +
            alert.components.liquidity +
            alert.components.offPrice +
            alert.components.volatility +
            alert.components.volumeShare) /
          5
        ).toFixed(3)
      ),
      coherence: 0,
      coverage: 0,
    },
    h0Adjustments: {
      appliedSuppression: 0,
      drivers,
    },
    evidence,
    missingDataNotes: pbp.available
      ? []
      : [
          {
            source: "nba",
            reason: "persisted NBA play-by-play missing for this game snapshot",
          },
        ],
    inspect: {
      payloadVersion: 1,
      instrumentIds: alert.instrumentId ? [alert.instrumentId] : [],
      sourceMarketIds: [alert.sourceMarketId],
      relationFamilies: alert.family ? [alert.family] : [],
    },
    playByPlay: pbp,
    vigAdjusted: null,
  };
}
