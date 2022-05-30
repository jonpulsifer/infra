#!/usr/bin/env bash
function deploy(){
    gcloud functions deploy view-counter \
	   --trigger-http \
	   --security-level=secure-always \
	   --allow-unauthenticated \
	   --region=northamerica-northeast1 \
	   --runtime=go116 \
	   --entry-point ViewCounter \
	   --project=homelab-ng \
	   --service-account=view-counter@homelab-ng.iam.gserviceaccount.com \
	   --memory=128Mi \
	   --max-instances=1 \
	   --set-env-vars GCP_PROJECT=homelab-ng
}

deploy "${1}"
