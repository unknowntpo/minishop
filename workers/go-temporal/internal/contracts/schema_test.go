package contracts

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestBuyIntentCommandFixtures(t *testing.T) {
	validFixtures, err := readFixtureGroup("valid")
	if err != nil {
		t.Fatalf("read valid fixtures: %v", err)
	}

	for _, fixture := range validFixtures {
		if err := ValidateBuyIntentCommandDocument(fixture.payload); err != nil {
			t.Fatalf("expected valid fixture %s to pass, got %v", fixture.name, err)
		}
	}

	invalidFixtures, err := readFixtureGroup("invalid")
	if err != nil {
		t.Fatalf("read invalid fixtures: %v", err)
	}

	for _, fixture := range invalidFixtures {
		if err := ValidateBuyIntentCommandDocument(fixture.payload); err == nil {
			t.Fatalf("expected invalid fixture %s to fail validation", fixture.name)
		}
	}
}

type fixtureFile struct {
	name    string
	payload []byte
}

func readFixtureGroup(group string) ([]fixtureFile, error) {
	root, err := findContractFile(filepath.Join("fixtures", "buy-intent-command", group))
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}

	fixtures := make([]fixtureFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		payload, err := os.ReadFile(filepath.Join(root, entry.Name()))
		if err != nil {
			return nil, err
		}

		fixtures = append(fixtures, fixtureFile{
			name:    entry.Name(),
			payload: payload,
		})
	}

	sort.Slice(fixtures, func(i, j int) bool {
		return fixtures[i].name < fixtures[j].name
	})

	return fixtures, nil
}
