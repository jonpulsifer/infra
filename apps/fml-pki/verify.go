package main

import (
	"bytes"
	"crypto/x509"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// pathLen reports the pathLenConstraint and whether the extension carried one.
// Go splits this across two fields because DER cannot distinguish an absent
// constraint from a zero one by value alone — which is the exact ambiguity that
// makes opentofu/tls drop `max_path_length = 0` on the floor.
func pathLen(c *x509.Certificate) (int, bool) {
	if c.MaxPathLenZero {
		return 0, true
	}
	if c.MaxPathLen > 0 {
		return c.MaxPathLen, true
	}
	return 0, false
}

func describe(c *x509.Certificate, name string) string {
	shown := "unset"
	if n, ok := pathLen(c); ok {
		shown = fmt.Sprint(n)
	}
	return fmt.Sprintf("%s (CA=%t, pathLen=%s, notAfter=%s)",
		name, c.IsCA, shown, c.NotAfter.UTC().Format("2006-01-02"))
}

type named struct {
	cert *x509.Certificate
	name string
}

// checkChain takes the chain leaf-most CA first, root last.
func checkChain(label string, chain []named) []string {
	var problems []string

	for i := 0; i+1 < len(chain); i++ {
		lower, upper := chain[i], chain[i+1]
		if !bytes.Equal(lower.cert.RawIssuer, upper.cert.RawSubject) {
			problems = append(problems, fmt.Sprintf(
				"%s: %s is issued by %q, but %s is %q",
				label, lower.name, lower.cert.Issuer, upper.name, upper.cert.Subject))
			continue
		}
		// Linkage by name is not linkage by key; a stale anchor with a matching
		// subject would otherwise pass.
		if err := lower.cert.CheckSignatureFrom(upper.cert); err != nil {
			problems = append(problems, fmt.Sprintf(
				"%s: %s does not carry a valid signature from %s: %v",
				label, lower.name, upper.name, err))
		}
	}

	root := chain[len(chain)-1]
	if !bytes.Equal(root.cert.RawSubject, root.cert.RawIssuer) {
		problems = append(problems, fmt.Sprintf(
			"%s: %s terminates the chain but is not self-signed (issuer %q) — "+
				"OpenSSL cannot anchor here", label, root.name, root.cert.Issuer))
	}

	for _, n := range chain {
		if !n.cert.IsCA {
			problems = append(problems, fmt.Sprintf(
				"%s: %s is in the CA chain without basicConstraints CA:TRUE", label, n.name))
		}
	}

	// pathLenConstraint caps the CAs that may follow, excluding the end-entity.
	// chain[0] issues leaves, so nothing follows it.
	for depth, n := range chain {
		limit, ok := pathLen(n.cert)
		if !ok || limit >= depth {
			continue
		}
		below := make([]string, depth)
		for i := 0; i < depth; i++ {
			below[i] = chain[i].name
		}
		problems = append(problems, fmt.Sprintf(
			"%s: %s carries pathLen=%d but signs %d CA(s) beneath it (%s) — needs pathLen >= %d",
			label, n.name, limit, depth, strings.Join(below, ", "), depth))
	}

	for i := 0; i+1 < len(chain); i++ {
		lower, upper := chain[i], chain[i+1]
		if upper.cert.NotAfter.Before(lower.cert.NotAfter) {
			problems = append(problems, fmt.Sprintf(
				"%s: %s expires %s, before %s which it signed (%s)",
				label, upper.name, upper.cert.NotAfter.UTC().Format("2006-01-02"),
				lower.name, lower.cert.NotAfter.UTC().Format("2006-01-02")))
		}
	}

	return problems
}

// checkChainFile asserts that <cluster>-ca-chain.pem is what kube-controller-
// manager can hand to every pod as ca.crt: the cluster CA, then each issuer up
// to a self-signed root. It is deliberately not the same file as
// <cluster>-ca-bundle.pem, which is a rotation overlap set (current plus
// previous CA) and carries no chain.
//
// This file must never become services.kubernetes.caFile. That option also
// feeds clientCaFile and kubeletClientCaFile, so putting the FML anchors in it
// would let anything issued anywhere under the FML Root authenticate to the API
// server. Only --root-ca-file takes the chain.
func checkChainFile(label, path string, clusterCA *x509.Certificate) []string {
	certs, err := readCerts(path)
	if err != nil {
		return []string{fmt.Sprintf("%s: %v", label, err)}
	}
	var problems []string
	if !bytes.Equal(certs[0].Raw, clusterCA.Raw) {
		problems = append(problems, fmt.Sprintf(
			"%s: %s starts with %q, not the cluster CA it is published for",
			label, filepath.Base(path), certs[0].Subject))
	}
	chain := make([]named, len(certs))
	for i, c := range certs {
		chain[i] = named{c, fmt.Sprintf("%s[%d] %s", filepath.Base(path), i, c.Subject.CommonName)}
	}
	if len(chain) < 2 {
		problems = append(problems, fmt.Sprintf(
			"%s: %s holds one certificate, so an OpenSSL client cannot build a path out of it",
			label, filepath.Base(path)))
		return problems
	}
	return append(problems, checkChain(label, chain)...)
}

// runVerify asserts what a Go client never exercises. crypto/x509 treats every
// certificate in a trust store as an anchor and stops there, so a hierarchy can
// contradict itself and still serve kubectl, Flux and Prometheus for years.
// OpenSSL builds the full path and rejects it.
func runVerify(certsDir string, out, errOut io.Writer) error {
	root, err := readCert(filepath.Join(certsDir, "fml-root.pem"))
	if err != nil {
		return fmt.Errorf("cannot load trust anchors: %w", err)
	}
	intermediate, err := readCert(filepath.Join(certsDir, "fml-intermediate.pem"))
	if err != nil {
		return fmt.Errorf("cannot load trust anchors: %w", err)
	}

	matches, err := filepath.Glob(filepath.Join(certsDir, "*-ca.pem"))
	if err != nil {
		return err
	}
	var clusterCAs []string
	for _, m := range matches {
		if !strings.HasPrefix(filepath.Base(m), "fml-") {
			clusterCAs = append(clusterCAs, m)
		}
	}
	sort.Strings(clusterCAs)
	if len(clusterCAs) == 0 {
		return fmt.Errorf("no cluster CA certificates in %s", certsDir)
	}

	var problems []string
	for _, path := range clusterCAs {
		base := filepath.Base(path)
		cluster := strings.TrimSuffix(base, "-ca.pem")
		clusterCA, err := readCert(path)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", cluster, err))
			continue
		}
		chain := []named{
			{clusterCA, base},
			{intermediate, "fml-intermediate.pem"},
			{root, "fml-root.pem"},
		}
		fmt.Fprintf(out, "==> %s\n", cluster)
		for _, n := range chain {
			fmt.Fprintf(out, "      %s\n", describe(n.cert, n.name))
		}
		problems = append(problems, checkChain(cluster, chain)...)

		chainPath := filepath.Join(certsDir, cluster+"-ca-chain.pem")
		if _, statErr := os.Stat(chainPath); statErr == nil {
			problems = append(problems, checkChainFile(cluster, chainPath, clusterCA)...)
		} else {
			fmt.Fprintf(out, "      %s-ca-chain.pem absent — pods still receive the cluster CA alone\n", cluster)
		}
	}

	if len(problems) > 0 {
		fmt.Fprintln(errOut, "\nchain does not validate:")
		for _, p := range problems {
			fmt.Fprintf(errOut, "  - %s\n", p)
		}
		fmt.Fprintln(errOut, "\nGo clients accept this because they anchor on the "+
			"published cert and never walk up.\nOpenSSL clients build the full path and refuse it.")
		return errFailed
	}

	fmt.Fprintln(out, "\nok — every chain links and is signed through, anchors on a "+
		"self-signed root, and its pathLen and validity admit the CAs beneath it")
	return nil
}
