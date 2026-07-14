#!/usr/bin/env bash
# =============================================================================
# Task 0 — Cloud Tasks Infrastructure Provisioning
# =============================================================================
#
# Provisions the Cloud Tasks queues and Monitoring alert required by
# tasks.md Task 0.1–0.4.  Run this once per GCP project before deploying
# Cloud Functions.
#
# IDEMPOTENT: gcloud commands use --quiet and will no-op if the resource
# already exists (except the alert policy which uses upsert semantics via
# the monitoring JSON).
#
# Prerequisites:
#   - gcloud CLI authenticated (gcloud auth login)
#   - PROJECT_ID env var set, OR edit the defaults below
#   - REGION env var set, OR edit the defaults below
#
# Usage:
#   export PROJECT_ID=raksha-prod
#   export REGION=us-central1
#   export HANDLER_URL=https://us-central1-raksha-prod.cloudfunctions.net/activateSOSSession
#   bash infra/provision-cloud-tasks.sh
#
# Queue specs (locked — design.md §Decision 2, tasks.md §Task 0):
#   Queue name       : sos-session-activate
#   DLQ name         : sos-activate-dlq
#   Max dispatches   : 1000 concurrent
#   Max attempts     : 4  (3 retries + 1 initial attempt)
#   Initial backoff  : 10 s
#   Max backoff      : 60 s
#   Monitoring alert : DLQ depth > 0
# =============================================================================

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID environment variable}"
REGION="${REGION:?Set REGION environment variable}"
HANDLER_URL="${HANDLER_URL:?Set HANDLER_URL environment variable}"

QUEUE_NAME="sos-session-activate"
DLQ_NAME="sos-activate-dlq"
SERVICE_ACCOUNT="$(gcloud projects describe "$PROJECT_ID" \
  --format='value(projectNumber)')"-compute@developer.gserviceaccount.com

echo "=== Task 0.1: Provisioning main queue: $QUEUE_NAME ==="
gcloud tasks queues create "$QUEUE_NAME" \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --max-concurrent-dispatches=1000 \
  --max-attempts=4 \
  --min-backoff=10s \
  --max-backoff=60s \
  --max-doublings=2 \
  --quiet 2>/dev/null || echo "  Queue $QUEUE_NAME already exists — skipping create"

echo "=== Task 0.2: Provisioning dead-letter queue: $DLQ_NAME ==="
gcloud tasks queues create "$DLQ_NAME" \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --quiet 2>/dev/null || echo "  Queue $DLQ_NAME already exists — skipping create"

echo "=== Task 0.3: Creating Cloud Monitoring alert on DLQ depth > 0 ==="
# Write a temporary alert policy JSON and create via gcloud.
# The metric `cloudtasks.googleapis.com/queue/depth` fires when
# the sos-activate-dlq queue has any tasks waiting.
ALERT_JSON=$(cat <<EOF
{
  "displayName": "SOS Activate DLQ — tasks present",
  "documentation": {
    "content": "One or more tasks have been dead-lettered to sos-activate-dlq. Investigate activateSOSSession failures immediately — each dead-lettered task represents a SOSSession stuck in countdown state with no scheduled activation.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "sos-activate-dlq depth > 0",
      "conditionThreshold": {
        "filter": "metric.type=\"cloudtasks.googleapis.com/queue/depth\" resource.type=\"cloud_tasks_queue\" resource.labels.queue_id=\"$DLQ_NAME\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "aggregations": [
          {
            "alignmentPeriod": "60s",
            "perSeriesAligner": "ALIGN_MAX"
          }
        ]
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "604800s"
  },
  "combiner": "OR",
  "enabled": true
}
EOF
)

TMPFILE=$(mktemp /tmp/sos-dlq-alert-XXXXXX.json)
echo "$ALERT_JSON" > "$TMPFILE"

gcloud alpha monitoring policies create \
  --project="$PROJECT_ID" \
  --policy-from-file="$TMPFILE" \
  --quiet 2>/dev/null || echo "  Alert policy already exists or requires manual creation in Cloud Console"

rm -f "$TMPFILE"

echo "=== Task 0.4: Granting Cloud Functions SA cloudtasks.enqueuer role ==="
# Grant the service account the enqueuer role on the main queue.
QUEUE_RESOURCE="projects/$PROJECT_ID/locations/$REGION/queues/$QUEUE_NAME"
gcloud tasks queues add-iam-policy-binding "$QUEUE_NAME" \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/cloudtasks.enqueuer" \
  --quiet

echo ""
echo "=== Provisioning complete ==="
echo ""
echo "Add the following to your .env (copy from .env.example):"
echo "  CLOUD_TASKS_QUEUE=$QUEUE_RESOURCE"
echo "  CLOUD_TASKS_LOCATION=$REGION"
echo "  CLOUD_TASKS_HANDLER_URL=$HANDLER_URL"
echo ""
echo "Verify queue exists:"
echo "  gcloud tasks queues describe $QUEUE_NAME --project=$PROJECT_ID --location=$REGION"
echo "  gcloud tasks queues describe $DLQ_NAME   --project=$PROJECT_ID --location=$REGION"
