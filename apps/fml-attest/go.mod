module github.com/jonpulsifer/infra/apps/fml-attest

go 1.25.0

// The canonicaliser is shared rather than copied: two RFC 8785 implementations
// that drift are two answers to "what bytes were signed". It is the only
// package this module links from outside the standard library, and it handles
// no keys -- `go list -deps` is the check.
require github.com/jonpulsifer/infra/apps/fml-ceremony v0.0.0

replace github.com/jonpulsifer/infra/apps/fml-ceremony => ../fml-ceremony
