"""Writes one object with google-cloud-storage and Application Default
Credentials. Nothing here names a credential: the library reads
GOOGLE_APPLICATION_CREDENTIALS and runs the executable the document names for
its subject token."""

import datetime
import os

from google.cloud import storage

bucket_name = os.environ["BUCKET"]
node = os.environ["NODE_NAME"]
client = storage.Client(project=os.environ["GCP_PROJECT"])
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
name = f"uploads/{stamp}-{node}-python.txt"
# upload_from_string is one request: the grant allows object create and nothing else.
client.bucket(bucket_name).blob(name).upload_from_string(
    f"Uploaded by Python google-cloud-storage from {node} through spiffe-adc with no key file and no sidecar.\n",
    content_type="text/plain",
)
print(f"Uploaded gs://{bucket_name}/{name}")
