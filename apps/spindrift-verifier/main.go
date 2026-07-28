package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jonpulsifer/infra/apps/spindrift-verifier/pkg/verifier"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: spindrift-verifier <verify|sign|verify-image|sign-legacy> [args...]")
		os.Exit(1)
	}

	command := os.Args[1]
	switch command {
	case "verify":
		runVerifyCommand(os.Args[2:])
	case "sign":
		runSignCommand(os.Args[2:])
	case "verify-image":
		runVerifyImageLegacyCommand(os.Args[2:])
	case "sign-legacy":
		runSignLegacyCommand(os.Args[2:])
	default:
		// Check if called as cosign legacy flag command: "spindrift-verifier sign ..."
		if command == "sign" && len(os.Args) > 2 && os.Args[2] != "--request-path" {
			runSignLegacyCommand(os.Args[2:])
			return
		}
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", command)
		os.Exit(1)
	}
}

func runVerifyCommand(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	requestPath := fs.String("request-path", "", "Path to verification request JSON file (stdin if empty)")
	_ = fs.Parse(args)

	reqData, err := readInputData(*requestPath)
	if err != nil {
		outputErrorResponse("PROVENANCE_INVALID", fmt.Sprintf("failed to read request input: %v", err))
		return
	}

	var req verifier.VerificationRequest
	if err := json.Unmarshal(reqData, &req); err != nil {
		outputErrorResponse("PROVENANCE_INVALID", fmt.Sprintf("failed to parse verification request: %v", err))
		return
	}

	resp := verifier.Verify(req, time.Now)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(resp)
}

func runSignCommand(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	requestPath := fs.String("request-path", "", "Path to sign request JSON file (stdin if empty)")
	
	// Check if this is legacy cosign invocation: e.g. "sign --yes --key ..."
	if len(args) > 0 && args[0] != "-request-path" && args[0] != "--request-path" {
		runSignLegacyCommand(args)
		return
	}

	_ = fs.Parse(args)

	reqData, err := readInputData(*requestPath)
	if err != nil {
		outputSignErrorResponse("SIGNING_FAILED", fmt.Sprintf("failed to read sign request input: %v", err))
		return
	}

	var req verifier.SignRequest
	if err := json.Unmarshal(reqData, &req); err != nil {
		outputSignErrorResponse("SIGNING_FAILED", fmt.Sprintf("failed to parse sign request: %v", err))
		return
	}

	resp := verifier.Sign(req, time.Now)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(resp)
}

func runVerifyImageLegacyCommand(args []string) {
	// Flags matching slsa-verifier verify-image syntax
	fs := flag.NewFlagSet("verify-image", flag.ExitOnError)
	provenancePath := fs.String("provenance-path", "", "Path to provenance JSON file")
	sourceURI := fs.String("source-uri", "", "Expected source URI")
	builderID := fs.String("builder-id", "", "Expected builder ID")
	_ = fs.String("print-provenance", "", "Print provenance flag")

	var ref string
	nonFlagArgs := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--provenance-path" && i+1 < len(args) {
			*provenancePath = args[i+1]
			i++
		} else if args[i] == "--source-uri" && i+1 < len(args) {
			*sourceURI = args[i+1]
			i++
		} else if args[i] == "--builder-id" && i+1 < len(args) {
			*builderID = args[i+1]
			i++
		} else if args[i] == "--print-provenance" {
			// boolean flag
		} else if args[i][0] != '-' && ref == "" {
			ref = args[i]
		} else {
			nonFlagArgs = append(nonFlagArgs, args[i])
		}
	}

	if *provenancePath == "" {
		fmt.Fprintln(os.Stderr, "error: --provenance-path is required")
		os.Exit(1)
	}

	provData, err := os.ReadFile(*provenancePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading provenance path: %v\n", err)
		os.Exit(1)
	}

	digest := extractDigestFromRef(ref)

	req := verifier.VerificationRequest{
		Version: "v1",
		Artifact: verifier.Artifact{
			Digest: digest,
			Refs:   []string{ref},
		},
		Provenance: verifier.Provenance{
			Statement:    json.RawMessage(provData),
			ClaimedLevel: 2,
		},
		Expectations: verifier.Expectations{
			Backend:           "hosted",
			ExpectedBuilderID: *builderID,
			MinimumLevel:      1,
			MaximumLevel:      2,
			SourceURI:         *sourceURI,
		},
	}

	resp := verifier.Verify(req, time.Now)
	if !resp.OK {
		fmt.Fprintln(os.Stderr, resp.Message)
		os.Exit(1)
	}

	// Print raw envelope on stdout for slsa-verifier compatibility
	os.Stdout.Write(resp.Assessment.Envelope)
	fmt.Println()
}

func runSignLegacyCommand(args []string) {
	// Flags matching cosign sign syntax: --yes --key <key> --tlog-upload=false --bundle <bundlePath> <immutableRef>
	var key, bundlePath, ref string
	for i := 0; i < len(args); i++ {
		if args[i] == "--key" && i+1 < len(args) {
			key = args[i+1]
			i++
		} else if args[i] == "--bundle" && i+1 < len(args) {
			bundlePath = args[i+1]
			i++
		} else if len(args[i]) > 0 && args[i][0] != '-' {
			ref = args[i]
		}
	}

	digest := extractDigestFromRef(ref)
	req := verifier.SignRequest{
		Version: "v1",
		Artifact: verifier.Artifact{
			Digest: digest,
			Refs:   []string{ref},
		},
		Key: key,
	}

	resp := verifier.Sign(req, time.Now)
	if !resp.OK {
		fmt.Fprintln(os.Stderr, resp.Message)
		os.Exit(1)
	}

	bundleJSON, _ := json.Marshal(resp.Signature.Bundle)
	if bundlePath != "" {
		_ = os.WriteFile(bundlePath, bundleJSON, 0600)
	}
	os.Stdout.Write(bundleJSON)
	fmt.Println()
}

func readInputData(path string) ([]byte, error) {
	if path != "" {
		return os.ReadFile(path)
	}
	return io.ReadAll(os.Stdin)
}

func extractDigestFromRef(ref string) string {
	idx := len(ref) - 1
	for idx >= 0 {
		if ref[idx] == '@' {
			return ref[idx+1:]
		}
		idx--
	}
	return ref
}

func outputErrorResponse(code, message string) {
	resp := verifier.VerificationResponse{
		Version: "v1",
		OK:      false,
		Code:    code,
		Message: message,
	}
	_ = json.NewEncoder(os.Stdout).Encode(resp)
}

func outputSignErrorResponse(code, message string) {
	resp := verifier.SignResponse{
		Version: "v1",
		OK:      false,
		Code:    code,
		Message: message,
	}
	_ = json.NewEncoder(os.Stdout).Encode(resp)
}
