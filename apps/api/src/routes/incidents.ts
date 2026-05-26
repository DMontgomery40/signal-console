// Known Cases routes.
//
// GET lists the official generated benchmark incidents plus operator-entered
// desk assertions. POST accepts the desk's claim as authoritative input: it
// validates only the minimum shape needed to search/replay, not whether the
// stat/player claim is plausible or official.

import { GOLD_DB_PATH } from "@signal-console/db";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  appendDeskIncident,
  DEFAULT_BAKEOFF_RESULTS_PATH,
  DEFAULT_DESK_INCIDENTS_PATH,
  listKnownCases,
} from "../services/incidents";
import { parseStrictIsoTimestamp } from "../services/timestamps";

export interface IncidentsRoutesOptions {
  readonly bakeoffResultsPath?: string;
  readonly deskIncidentsPath?: string;
  readonly goldDbPath?: string;
}

const optionalText = z.string().trim().max(2000).optional();

const createIncidentBodySchema = z
  .object({
    incidentName: z.string().trim().min(1).max(240),
    claim: z.string().trim().min(1).max(4000),
    utcTime: optionalText,
    gameClock: optionalText,
    period: optionalText,
    teamOne: optionalText,
    teamTwo: optionalText,
    gameId: optionalText,
    stat: optionalText,
    creditedPlayer: optionalText,
    rightfulPlayer: optionalText,
    notes: optionalText,
    createdBy: optionalText,
  })
  .superRefine((body, ctx) => {
    const hasUtc = (body.utcTime ?? "").length > 0;
    const hasClock = (body.gameClock ?? "").length > 0;
    const hasTeamOrGame =
      (body.teamOne ?? "").length > 0 ||
      (body.teamTwo ?? "").length > 0 ||
      (body.gameId ?? "").length > 0;
    if (!hasUtc && !hasClock) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "one time anchor is required: utcTime or gameClock",
      });
    }
    if (!hasTeamOrGame) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "one team hint or gameId is required",
      });
    }
    if (
      hasUtc &&
      parseStrictIsoTimestamp(body.utcTime ?? "", { requireExplicitTimezone: true }) === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "utcTime must be an ISO timestamp with timezone",
        path: ["utcTime"],
      });
    }
  });

const caseResultSchema = {
  type: ["object", "null"],
  required: ["algoId", "scoreable", "caught", "leadSeconds", "fireIso", "skipReason"],
  properties: {
    algoId: { type: "string" },
    scoreable: { type: "boolean" },
    caught: { type: "boolean" },
    leadSeconds: { type: ["number", "null"] },
    fireIso: { type: ["string", "null"] },
    skipReason: { type: ["string", "null"] },
  },
} as const;

const knownCaseSchema = {
  type: "object",
  required: [
    "id",
    "origin",
    "incidentName",
    "claim",
    "confidence",
    "anchorType",
    "gameDate",
    "teams",
    "gameId",
    "period",
    "clock",
    "utcTime",
    "stat",
    "creditedPlayer",
    "rightfulPlayer",
    "sourceOrigin",
    "sourceReference",
    "sourceTextSummary",
    "notes",
    "officialCorrection",
    "localBoardGameIds",
    "scoreable",
    "liveControl",
    "bestResult",
    "createdAt",
    "createdBy",
  ],
  properties: {
    id: { type: "string" },
    origin: { type: "string", enum: ["benchmark", "desk-entered"] },
    incidentName: { type: "string" },
    claim: { type: "string" },
    confidence: { type: "string" },
    anchorType: { type: "string" },
    gameDate: { type: "string" },
    teams: { type: "string" },
    gameId: { type: "string" },
    period: { type: "string" },
    clock: { type: "string" },
    utcTime: { type: "string" },
    stat: { type: "string" },
    creditedPlayer: { type: "string" },
    rightfulPlayer: { type: "string" },
    sourceOrigin: { type: "string" },
    sourceReference: { type: "string" },
    sourceTextSummary: { type: "string" },
    notes: { type: "string" },
    officialCorrection: { type: "boolean" },
    localBoardGameIds: { type: "array", items: { type: "string" } },
    scoreable: { type: "boolean" },
    liveControl: caseResultSchema,
    bestResult: caseResultSchema,
    createdAt: { type: ["string", "null"] },
    createdBy: { type: ["string", "null"] },
  },
} as const;

const listResponseSchema = {
  type: "object",
  required: ["generatedAt", "coverage", "incidents"],
  properties: {
    generatedAt: { type: ["string", "null"] },
    coverage: {
      type: "object",
      required: [
        "totalIncidents",
        "exactAnchorIncidents",
        "scoreableIncidents",
        "denominatorGames",
      ],
      properties: {
        totalIncidents: { type: "integer" },
        exactAnchorIncidents: { type: "integer" },
        scoreableIncidents: { type: "integer" },
        denominatorGames: { type: "integer" },
      },
    },
    incidents: { type: "array", items: knownCaseSchema },
  },
} as const;

const createRequestSchema = {
  type: "object",
  required: ["incidentName", "claim"],
  properties: {
    incidentName: { type: "string", minLength: 1, maxLength: 240 },
    claim: { type: "string", minLength: 1, maxLength: 4000 },
    utcTime: {
      type: "string",
      maxLength: 2000,
      description: "ISO timestamp with explicit timezone when known.",
    },
    gameClock: { type: "string", maxLength: 2000 },
    period: { type: "string", maxLength: 2000 },
    teamOne: { type: "string", maxLength: 2000 },
    teamTwo: { type: "string", maxLength: 2000 },
    gameId: { type: "string", maxLength: 2000 },
    stat: { type: "string", maxLength: 2000 },
    creditedPlayer: { type: "string", maxLength: 2000 },
    rightfulPlayer: { type: "string", maxLength: 2000 },
    notes: { type: "string", maxLength: 2000 },
    createdBy: { type: "string", maxLength: 2000 },
  },
  description:
    "Requires one time anchor (utcTime or gameClock) and one game hint (teamOne, teamTwo, or gameId). The route validates this after trimming so whitespace-only fields do not count.",
  additionalProperties: false,
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

const incidentsRoutes: FastifyPluginAsync<IncidentsRoutesOptions> = (app, opts) => {
  const bakeoffResultsPath = opts.bakeoffResultsPath ?? DEFAULT_BAKEOFF_RESULTS_PATH;
  const deskIncidentsPath = opts.deskIncidentsPath ?? DEFAULT_DESK_INCIDENTS_PATH;
  const goldDbPath = opts.goldDbPath ?? GOLD_DB_PATH;

  app.get(
    "/v1/incidents",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "List benchmarked and desk-entered known cases",
        description:
          "Returns the generated bakeoff incident registry plus operator-entered desk assertions. Desk-entered rows are accepted as trader claims; replay/matching may still report no local feed evidence.",
        response: {
          200: listResponseSchema,
        },
      },
    },
    (_request: FastifyRequest, reply: FastifyReply) => {
      reply.send(listKnownCases({ bakeoffResultsPath, deskIncidentsPath }));
    },
  );

  app.post(
    "/v1/incidents",
    {
      schema: {
        tags: ["desk-stable"],
        summary: "Create a desk-entered known case assertion",
        description:
          "Accepts the trading desk's incident assertion with one time anchor and one team/game hint. Does not validate player plausibility, stat totals, or official NBA correction state.",
        body: createRequestSchema,
        response: {
          201: knownCaseSchema,
          400: errorResponseSchema,
        },
      },
    },
    (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createIncidentBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: `invalid body: ${parsed.error.message}` });
        return;
      }
      const body = parsed.data;
      const utcTime = nonEmpty(body.utcTime);
      const gameClock = nonEmpty(body.gameClock);
      const period = nonEmpty(body.period);
      const teamOne = nonEmpty(body.teamOne);
      const teamTwo = nonEmpty(body.teamTwo);
      const gameId = nonEmpty(body.gameId);
      const stat = nonEmpty(body.stat);
      const creditedPlayer = nonEmpty(body.creditedPlayer);
      const rightfulPlayer = nonEmpty(body.rightfulPlayer);
      const notes = nonEmpty(body.notes);
      const createdBy = nonEmpty(body.createdBy);
      const incident = appendDeskIncident(
        {
          incidentName: body.incidentName,
          claim: body.claim,
          ...(utcTime === undefined ? {} : { utcTime }),
          ...(gameClock === undefined ? {} : { gameClock }),
          ...(period === undefined ? {} : { period }),
          ...(teamOne === undefined ? {} : { teamOne }),
          ...(teamTwo === undefined ? {} : { teamTwo }),
          ...(gameId === undefined ? {} : { gameId }),
          ...(stat === undefined ? {} : { stat }),
          ...(creditedPlayer === undefined ? {} : { creditedPlayer }),
          ...(rightfulPlayer === undefined ? {} : { rightfulPlayer }),
          ...(notes === undefined ? {} : { notes }),
          ...(createdBy === undefined ? {} : { createdBy }),
        },
        { deskIncidentsPath, goldDbPath },
      );
      reply.code(201).send(incident);
    },
  );

  return Promise.resolve();
};

export default incidentsRoutes;
