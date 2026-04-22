package e2e_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var testEnv *environment

func TestGoBackendE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Go Backend E2E Suite")
}

var _ = BeforeSuite(func() {
	SetDefaultEventuallyTimeout(30 * time.Second)
	SetDefaultEventuallyPollingInterval(250 * time.Millisecond)

	baseURL := envOrDefault("GO_BACKEND_E2E_BASE_URL", "http://go-backend:3000")
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		Skip("DATABASE_URL is not configured; run this suite through docker compose.")
	}
	repoRoot := envOrDefault("GO_BACKEND_E2E_REPO_ROOT", "/workspace")

	db, err := pgxpool.New(context.Background(), databaseURL)
	Expect(err).NotTo(HaveOccurred())

	testEnv = &environment{
		baseURL:  baseURL,
		repoRoot: repoRoot,
		db:       db,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}

	Eventually(func() error {
		status, err := testEnv.healthz(context.Background())
		if err != nil {
			return err
		}
		if status != http.StatusOK {
			return fmt.Errorf("healthz returned %d", status)
		}
		return nil
	}).Should(Succeed())

	Expect(testEnv.applyMigrations(context.Background())).To(Succeed())
	Expect(testEnv.seedCatalog(context.Background())).To(Succeed())
})

var _ = BeforeEach(func() {
	Expect(testEnv.resetBusinessState(context.Background())).To(Succeed())
	Expect(testEnv.seedCatalog(context.Background())).To(Succeed())
})

var _ = AfterSuite(func() {
	if testEnv != nil && testEnv.db != nil {
		testEnv.db.Close()
	}
})

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
