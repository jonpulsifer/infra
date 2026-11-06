// go-upload writes one object with cloud.google.com/go/storage and
// Application Default Credentials. Nothing here names a credential: the
// library reads GOOGLE_APPLICATION_CREDENTIALS and runs the executable the
// document names for its subject token.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"cloud.google.com/go/storage"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	bucket, node := os.Getenv("BUCKET"), os.Getenv("NODE_NAME")
	client, err := storage.NewClient(ctx)
	if err != nil {
		log.Fatalf("storage.NewClient: %v", err)
	}
	defer client.Close()
	name := fmt.Sprintf("uploads/%s-%s-go.txt", time.Now().UTC().Format("20060102T150405Z"), node)
	w := client.Bucket(bucket).Object(name).NewWriter(ctx)
	w.ContentType = "text/plain"
	// One request: the grant allows object create and nothing else.
	w.ChunkSize = 0
	fmt.Fprintf(w, "Uploaded by Go cloud.google.com/go/storage from %s through spiffe-adc with no key file and no sidecar.\n", node)
	if err := w.Close(); err != nil {
		log.Fatalf("upload gs://%s/%s: %v", bucket, name, err)
	}
	fmt.Printf("Uploaded gs://%s/%s\n", bucket, name)
}
