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

// pathLen reports the pathLenConstraint and whether it is present. MaxPathLen 0
// alone cannot tell an absent constraint from zero; MaxPathLenZero does.
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
		// A stale anchor with a matching subject passes the name check.
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

// checkChainFile asserts <cluster>-ca-chain.pem runs from the cluster CA to a
// self-signed root. It must never back caFile, which also authenticates clients.
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

// runVerify checks what Go clients never exercise: crypto/x509 anchors on any
// trust store entry, and OpenSSL builds the full path.
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
		base := filepath.Base(m)
		if !strings.HasPrefix(base, "fml-") && !strings.HasPrefix(base, devidPrefix) {
			clusterCAs = append(clusterCAs, m)
		}
	}
	sort.Strings(clusterCAs)

	var problems []string
	if len(clusterCAs) == 0 {
		// Talos clusters carry their own CA outside the FML chain; the anchors still link.
		fmt.Fprintln(out, "==> fml")
		problems = append(problems, checkChain("fml", []named{
			{intermediate, "fml-intermediate.pem"},
			{root, "fml-root.pem"},
		})...)
	}
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

	problems = append(problems, checkDevIDCAs(certsDir, intermediate, root, out)...)

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

// devidPrefix names the issuing DevID CAs, folly-devid-ca-<name>.pem, each with
// an optional folly-devid-ca-<name>-chain.pem up to the root, and their bundle,
// folly-devid-ca.pem, which verifiers such as SPIRE's tpm_devid trust.
const devidPrefix = "folly-devid-ca"

// checkDevIDCAs asserts each issuing DevID CA sits under the FML intermediate,
// and that the bundle holds every one of them in file-name order and nothing else.
func checkDevIDCAs(certsDir string, intermediate, root *x509.Certificate, out io.Writer) []string {
	matches, err := filepath.Glob(filepath.Join(certsDir, devidPrefix+"-*.pem"))
	if err != nil {
		return []string{err.Error()}
	}
	sort.Strings(matches)
	var issuers, chains []string
	for _, m := range matches {
		if strings.HasSuffix(m, "-chain.pem") {
			chains = append(chains, m)
		} else {
			issuers = append(issuers, m)
		}
	}
	bundlePath := filepath.Join(certsDir, devidPrefix+".pem")
	_, statErr := os.Stat(bundlePath)
	if len(matches) == 0 && statErr != nil {
		return nil
	}

	var problems []string
	var want [][]byte
	byPath := map[string]*x509.Certificate{}
	fmt.Fprintln(out, "==> devid")
	for _, path := range issuers {
		base := filepath.Base(path)
		ca, err := readCert(path)
		if err != nil {
			problems = append(problems, fmt.Sprintf("devid: %v", err))
			continue
		}
		want = append(want, ca.Raw)
		byPath[path] = ca
		fmt.Fprintf(out, "      %s\n", describe(ca, base))
		problems = append(problems, checkChain("devid", []named{
			{ca, base},
			{intermediate, "fml-intermediate.pem"},
			{root, "fml-root.pem"},
		})...)
		if ca.KeyUsage&x509.KeyUsageCertSign == 0 {
			problems = append(problems, fmt.Sprintf("devid: %s lacks keyCertSign, so it cannot issue an LDevID", base))
		}
	}
	for _, chain := range chains {
		ca, ok := byPath[strings.TrimSuffix(chain, "-chain.pem")+".pem"]
		if !ok {
			problems = append(problems, fmt.Sprintf(
				"devid: %s names no issuing CA; name it %s-<name>-chain.pem beside %s-<name>.pem",
				filepath.Base(chain), devidPrefix, devidPrefix))
			continue
		}
		problems = append(problems, checkChainFile("devid", chain, ca)...)
	}

	const fix = "run `mise run devid:bundle`"
	if statErr != nil {
		return append(problems, fmt.Sprintf("devid: %s.pem is missing; %s", devidPrefix, fix))
	}
	bundle, err := readCerts(bundlePath)
	if err != nil {
		return append(problems, fmt.Sprintf("devid: %v; %s", err, fix))
	}
	same := len(bundle) == len(want)
	for i := 0; same && i < len(bundle); i++ {
		same = bytes.Equal(bundle[i].Raw, want[i])
	}
	if !same {
		problems = append(problems, fmt.Sprintf(
			"devid: %s.pem is not the %d issuing DevID CA(s) in file-name order; %s",
			devidPrefix, len(want), fix))
	}
	return problems
}
