# quant-lab-starter.R
#
# R bridge into the Signal Console quant-lab scorer. It reads a snapshot's
# board_observations, computes a trivial `fired` decision, and writes a
# predictions.parquet in the CANONICAL prediction contract that the python
# scorer validates and consumes.
#
# Canonical predictions schema (see
# apps/nba-sidecar/src/nba_sidecar/research/contracts/columns.py ::
# PREDICTION_COLUMNS). These four columns are the stable, runtime-agnostic
# contract — an R producer is treated identically to a native model:
#
#   game_id      character  : game the prediction bucket belongs to
#   bucket_start datetime   : bucket start instant; joins back to
#                             board_observations.bucket_start (tz-aware UTC)
#   score        double     : continuous alert/surprise score for the bucket
#   fired        logical    : alert decision (TRUE only where you choose to fire)
#
# Extra diagnostic columns are allowed (allow_extra=True) and will light up the
# residual-coverage diagnostic, but the four above are required.
#
# After writing predictions.parquet, score it identically to a native model:
#
#   pnpm quant score-predictions <predictions.parquet> <snapshot-dir> \
#     --model-id r-starter
#
# (equivalently: python -m nba_sidecar.research score-predictions ...). The
# scorer validates this file against PREDICTION_COLUMNS, then evaluates recall /
# fire-rate against the snapshot's incident truth, writing a run folder under
# outputs/nba-quant-lab/runs/.
#
# No R runtime is required by the repo's verify gate; this is a documented,
# correct starter. Run it yourself with:  Rscript scripts/quant-lab-starter.R

# --- dependencies ----------------------------------------------------------
# arrow is the simplest parquet path in R. duckdb is an equally valid backend
# (DBI::dbConnect(duckdb::duckdb()); read the snapshot.duckdb table directly) and
# mirrors the python loader's two-backend design; arrow is used here for brevity.
suppressPackageStartupMessages({
  library(arrow)    # read_parquet / write_parquet
})

# --- locate the snapshot ----------------------------------------------------
args <- commandArgs(trailingOnly = TRUE)
snapshot_dir <- if (length(args) >= 1) {
  args[[1]]
} else {
  # Default to the committed sample snapshot, relative to the repo root.
  file.path("outputs", "nba-quant-lab", "snapshots", "sample-fixed")
}
out_path <- if (length(args) >= 2) {
  args[[2]]
} else {
  file.path(snapshot_dir, "predictions-r-starter.parquet")
}

board_path <- file.path(snapshot_dir, "board_observations.parquet")
stopifnot(file.exists(board_path))

# --- load board_observations -----------------------------------------------
board <- read_parquet(board_path)

# --- trivial model ----------------------------------------------------------
# Honest placeholder: standardize intensity per game (z-score on the column),
# fire when it clears a fixed threshold. This is NOT a good model — it has no
# causality guard, no warmup, no robustness — it exists only to prove the
# write -> score-predictions bridge end to end. Replace the score/fired logic
# with a real model; keep the output schema identical.
intensity <- as.numeric(board$intensity)
mu <- mean(intensity, na.rm = TRUE)
sigma <- stats::sd(intensity, na.rm = TRUE)
if (is.na(sigma) || sigma == 0) sigma <- 1
score <- (intensity - mu) / sigma

predictions <- data.frame(
  game_id      = as.character(board$game_id),
  # bucket_start must join back to board_observations.bucket_start. Carry it
  # through as a tz-aware UTC timestamp (the python validator accepts a
  # datetime column or ISO-8601 strings).
  bucket_start = as.POSIXct(board$bucket_start, tz = "UTC"),
  score        = as.numeric(score),
  fired        = score >= 3.0,   # trivial threshold; logical -> parquet bool
  stringsAsFactors = FALSE
)

# Contract self-check before writing: required columns + types present.
stopifnot(
  all(c("game_id", "bucket_start", "score", "fired") %in% names(predictions)),
  is.character(predictions$game_id),
  inherits(predictions$bucket_start, "POSIXct"),
  is.numeric(predictions$score),
  is.logical(predictions$fired),
  !anyNA(predictions$fired)
)

write_parquet(predictions, out_path)

cat(sprintf(
  "wrote %d prediction rows -> %s\n", nrow(predictions), out_path
))
cat(sprintf("fired buckets: %d / %d\n", sum(predictions$fired), nrow(predictions)))
cat("score it with:\n")
cat(sprintf(
  "  pnpm quant score-predictions %s %s --model-id r-starter\n",
  out_path, snapshot_dir
))
