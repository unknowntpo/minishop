package contracts

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const buyIntentCommandSchemaFile = "buy-intent-command.schema.json"

var (
	buyIntentCommandSchemaOnce sync.Once
	buyIntentCommandSchema     *jsonschema.Schema
	buyIntentCommandSchemaErr  error
)

func ValidateBuyIntentCommandDocument(payload []byte) error {
	var value any
	if err := json.Unmarshal(payload, &value); err != nil {
		return err
	}

	return ValidateBuyIntentCommandValue(value)
}

func ValidateBuyIntentCommandValue(value any) error {
	schema, err := loadBuyIntentCommandSchema()
	if err != nil {
		return err
	}

	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("buy intent contract validation failed: %w", err)
	}

	return nil
}

func loadBuyIntentCommandSchema() (*jsonschema.Schema, error) {
	buyIntentCommandSchemaOnce.Do(func() {
		schemaPath, err := findContractFile(buyIntentCommandSchemaFile)
		if err != nil {
			buyIntentCommandSchemaErr = err
			return
		}

		compiler := jsonschema.NewCompiler()
		buyIntentCommandSchema, buyIntentCommandSchemaErr = compiler.Compile(pathToFileURL(schemaPath))
	})

	return buyIntentCommandSchema, buyIntentCommandSchemaErr
}

func findContractFile(relative string) (string, error) {
	for _, root := range contractRootCandidates() {
		path := filepath.Join(root, relative)
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}

	return "", fmt.Errorf("contract file %q was not found in any known contracts directory", relative)
}

func contractRootCandidates() []string {
	var roots []string

	if envDir := strings.TrimSpace(os.Getenv("MINISHOP_CONTRACTS_DIR")); envDir != "" {
		roots = append(roots, envDir)
	}

	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots,
			filepath.Join(cwd, "contracts"),
			filepath.Join(cwd, "..", "contracts"),
			filepath.Join(cwd, "..", "..", "contracts"),
			filepath.Join(cwd, "..", "..", "..", "contracts"),
			filepath.Join(cwd, "..", "..", "..", "..", "contracts"),
		)
	}

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		roots = append(roots,
			filepath.Join(exeDir, "contracts"),
			filepath.Join(exeDir, "..", "contracts"),
		)
	}

	return roots
}

func pathToFileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}
