import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function InternalBenchmarkProfilePage({
  searchParams,
}: {
  searchParams?: Promise<{ file?: string; run?: string; scenario?: string }>;
}) {
  const params = await searchParams;
  const relativePath = typeof params?.file === "string" ? params.file : "";

  if (relativePath.trim()) {
    redirect(profileStandaloneHref(relativePath, params?.scenario, params?.run));
  }

  return (
    <main className="page-shell admin-shell">
      <nav className="admin-nav">
        <Link className="text-link" href="/internal/benchmarks">
          Benchmark results
        </Link>
        <Link className="text-link" href="/internal/admin">
          Projection admin
        </Link>
      </nav>

      <section className="panel admin-panel" aria-labelledby="profile-empty-title">
        <p className="eyebrow">Profile viewer</p>
        <h1 id="profile-empty-title">Select a benchmark profile</h1>
        <p className="muted">
          Open this page from a profiling link in Benchmark results so the dedicated speedscope
          viewer can load one captured <code>.cpuprofile</code> file.
        </p>
      </section>
    </main>
  );
}

export function profileStandaloneHref(filePath: string, scenarioName?: string, runId?: string) {
  const searchParams = new URLSearchParams({
    file: filePath,
  });

  if (scenarioName) {
    searchParams.set("scenario", scenarioName);
  }

  if (runId) {
    searchParams.set("run", runId);
  }

  return `/internal/benchmarks/profiles/view?${searchParams.toString()}`;
}
