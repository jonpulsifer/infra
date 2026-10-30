// render renders a Tinkerbell Template's data on stdin the way the controller does when a Workflow
// starts: Go text/template with missingkey=error, against the JSON object in its one argument,
// which holds .Hardware and the Workflow's hardwareMap keys.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"text/template"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: render DATA_JSON < template-data")
		os.Exit(2)
	}
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		fail(err)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(os.Args[1]), &data); err != nil {
		fail(err)
	}
	t, err := template.New("workflow").Option("missingkey=error").Parse(string(src))
	if err != nil {
		fail(err)
	}
	if err := t.Execute(os.Stdout, data); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "render:", err)
	os.Exit(1)
}
