#!/usr/bin/env bash
set -e

# ==============================================================================
# Google Cloud Run Deployment Script
# Uber Voice Concierge (Gemini 3.1 Flash Live)
# ==============================================================================

SERVICE_NAME="${SERVICE_NAME:-uber-voice-concierge}"
REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo '')}"

echo "============================================================"
echo " Deploying Uber Voice Concierge to Google Cloud Run"
echo "============================================================"

# Verify gcloud CLI
if ! command -v gcloud &> /dev/null; then
    echo "Error: 'gcloud' CLI is not installed or not in PATH."
    echo "Install gcloud: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Ensure Project is set
if [ -z "$PROJECT_ID" ]; then
    read -p "Enter your Google Cloud Project ID: " PROJECT_ID
    gcloud config set project "$PROJECT_ID"
fi
echo "✓ Target GCP Project: $PROJECT_ID"
echo "✓ Target Region:      $REGION"
echo "✓ Target Service:     $SERVICE_NAME"

# Check for GEMINI_API_KEY
if [ -z "$GEMINI_API_KEY" ]; then
    if [ -f .env ] && grep -q "GEMINI_API_KEY=" .env; then
        GEMINI_API_KEY=$(grep "GEMINI_API_KEY=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    fi
fi

if [ -z "$GEMINI_API_KEY" ]; then
    read -sp "Enter your Gemini API Key: " GEMINI_API_KEY
    echo ""
fi

# Check for ALLOWED_EMAILS
ALLOWED_EMAILS="${ALLOWED_EMAILS:-}"
if [ -f .env ] && grep -q "ALLOWED_EMAILS=" .env; then
    ALLOWED_EMAILS=$(grep "ALLOWED_EMAILS=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
fi

# Check for GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET
if [ -z "$GOOGLE_CLIENT_ID" ] && [ -f .env ] && grep -q "GOOGLE_CLIENT_ID=" .env; then
    GOOGLE_CLIENT_ID=$(grep "GOOGLE_CLIENT_ID=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
fi
if [ -z "$GOOGLE_CLIENT_SECRET" ] && [ -f .env ] && grep -q "GOOGLE_CLIENT_SECRET=" .env; then
    GOOGLE_CLIENT_SECRET=$(grep "GOOGLE_CLIENT_SECRET=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")
fi

echo "✓ Whitelisted Emails: $ALLOWED_EMAILS"
echo "✓ Google SSO Mode:    ${GOOGLE_CLIENT_ID:+Configured (Active)}${GOOGLE_CLIENT_ID:-Not configured (Pass-through)}"

echo "============================================================"
echo " Step 1: Deploying container to Cloud Run via Cloud Build..."
echo "============================================================"

# Prepare environment variables using # delimiter for gcloud escaping
ENV_VARS="^#^GEMINI_API_KEY=${GEMINI_API_KEY}#NODE_ENV=production#ALLOWED_EMAILS=${ALLOWED_EMAILS}"
if [ -n "$GOOGLE_CLIENT_ID" ]; then
    ENV_VARS="${ENV_VARS}#GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}"
fi
if [ -n "$GOOGLE_CLIENT_SECRET" ]; then
    ENV_VARS="${ENV_VARS}#GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}"
fi

# Deploy with WebSocket session timeout (3600s), memory (512Mi), and concurrency (80)
gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --platform managed \
    --region "$REGION" \
    --project "$PROJECT_ID" \
    --timeout 3600 \
    --memory 512Mi \
    --concurrency 80 \
    --set-env-vars "$ENV_VARS" \
    --allow-unauthenticated

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --platform managed --region "$REGION" --project "$PROJECT_ID" --format 'value(status.url)')

echo "============================================================"
echo " Deployment Complete!"
echo " Service URL: $SERVICE_URL"
echo "============================================================"
echo ""
echo "🔐 Restricting Access to Googlers:"
echo "------------------------------------------------------------"
echo "Option 1: Google Cloud Identity-Aware Proxy (IAP)"
echo "  Follow standard GCP IAP setup behind an HTTPS Load Balancer"
echo "  to enforce @google.com corporate SSO on: $SERVICE_URL"
echo ""
echo "Option 2: Cloud IAM Invoker Policy (Require IAM Auth)"
echo "  Run the following commands to revoke public access and grant to Googlers:"
echo ""
echo "  # Remove public unauthenticated access:"
echo "  gcloud run services remove-iam-policy-binding $SERVICE_NAME \\"
echo "      --region=$REGION --member='allUsers' --role='roles/run.invoker'"
echo ""
echo "  # Grant access to your team or Google domain:"
echo "  gcloud run services add-iam-policy-binding $SERVICE_NAME \\"
echo "      --region=$REGION --member='domain:google.com' --role='roles/run.invoker'"
echo "============================================================"
