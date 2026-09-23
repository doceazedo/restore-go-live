import ErrorBoundary from "@components/ErrorBoundary";
import { useEffect, useReducer } from "@webpack/common";

export const JoinStage = {
  PREPARING: "Resolving public endpoint via STUN...",
  REQUESTING: "Sending connection request to the streamer...",
  WAITING_ANSWER: "Waiting for remote peer to answer connection request...",
  CONNECTING: "Running connectivity checks...",
  WAITING_VIDEO: "Connected! Waiting for the first frame...",
} as const;

const stages = new Map<string, string>();
const listeners = new Set<() => void>();

export function setJoinStage(key: string, stage: string | null) {
  if (stage == null) {
    if (!stages.delete(key)) return;
  } else {
    if (stages.get(key) === stage) return;
    stages.set(key, stage);
  }
  for (const listener of listeners) listener();
}

export function clearJoinStages() {
  stages.clear();
  for (const listener of listeners) listener();
}

function JoinStatusLabel({ streamKey }: { streamKey?: string; }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => void listeners.delete(rerender);
  }, []);

  const stage = streamKey ? stages.get(streamKey) : undefined;
  if (!stage) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(50% + 28px)",
        left: 0,
        right: 0,
        padding: "8px",
        textAlign: "center",
        fontFamily: "var(--font-primary)",
        fontSize: 14,
        fontWeight: 500,
        color: "var(--white, #fff)",
        textShadow: "0 1px 4px rgba(0, 0, 0, 0.6)",
        pointerEvents: "none",
      }}
    >
      {stage}
    </div>
  );
}

export const JoinStatus = ErrorBoundary.wrap(JoinStatusLabel, { noop: true });
