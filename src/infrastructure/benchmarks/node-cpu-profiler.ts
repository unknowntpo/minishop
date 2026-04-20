import "server-only";

import inspector from "node:inspector";

type CpuProfile = {
  nodes?: Array<{
    id: number;
    callFrame: {
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
    hitCount?: number;
    children?: number[];
  }>;
  startTime?: number;
  endTime?: number;
  samples?: number[];
  timeDeltas?: number[];
};

type ActiveCpuProfileSession = {
  label: string;
  runId: string;
  session: inspector.Session;
  startedAt: string;
};

declare global {
  var minishopActiveCpuProfile: ActiveCpuProfileSession | undefined;
}

export type CpuProfileCapture = {
  format: "cpuprofile";
  label: string;
  profile: CpuProfile;
  runId: string;
  startedAt: string;
  stoppedAt: string;
};

export async function startCpuProfile(input: { runId: string; label?: string }) {
  if (globalThis.minishopActiveCpuProfile) {
    throw new Error("A benchmark CPU profile session is already active.");
  }

  const session = new inspector.Session();
  session.connect();

  try {
    await postAsync(session, "Profiler.enable");
    await postAsync(session, "Profiler.start");
  } catch (error) {
    session.disconnect();
    throw error;
  }

  const activeSession: ActiveCpuProfileSession = {
    label: input.label?.trim() || "checkout-benchmark",
    runId: input.runId,
    session,
    startedAt: new Date().toISOString(),
  };

  globalThis.minishopActiveCpuProfile = activeSession;

  return {
    label: activeSession.label,
    runId: activeSession.runId,
    startedAt: activeSession.startedAt,
  };
}

export async function stopCpuProfile(input: { runId?: string }) {
  const activeSession = globalThis.minishopActiveCpuProfile;

  if (!activeSession) {
    throw new Error("No benchmark CPU profile session is active.");
  }

  if (input.runId && activeSession.runId !== input.runId) {
    throw new Error("Active benchmark CPU profile session does not match requested run.");
  }

  globalThis.minishopActiveCpuProfile = undefined;

  try {
    const result = (await postAsync(activeSession.session, "Profiler.stop")) as {
      profile?: CpuProfile;
    };
    await postAsync(activeSession.session, "Profiler.disable");

    return {
      format: "cpuprofile" as const,
      label: activeSession.label,
      profile: result.profile ?? {},
      runId: activeSession.runId,
      startedAt: activeSession.startedAt,
      stoppedAt: new Date().toISOString(),
    } satisfies CpuProfileCapture;
  } finally {
    activeSession.session.disconnect();
  }
}

function postAsync(session: inspector.Session, method: string, params?: object) {
  return new Promise<unknown>((resolve, reject) => {
    session.post(method, params ?? {}, (error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}
