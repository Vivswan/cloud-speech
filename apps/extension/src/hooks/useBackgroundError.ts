import { useEffect, useSyncExternalStore } from "react";
import {
  clearBackgroundError,
  getBackgroundError,
  getBackgroundErrorSequence,
  listenForBackgroundErrors,
  subscribeBackgroundError,
} from "@/lib/background-error";
import type { ErrorPayload } from "@/lib/protocol";

/** The last error the background pushed (or a request it never answered),
 *  received while a component using this hook is mounted. `sequence`
 *  changes with every report, a repeat of the same failure included. */
export function useBackgroundError(): {
  error: ErrorPayload | null;
  sequence: number;
  clearError: () => void;
} {
  const error = useSyncExternalStore(subscribeBackgroundError, getBackgroundError);
  const sequence = useSyncExternalStore(subscribeBackgroundError, getBackgroundErrorSequence);
  useEffect(() => listenForBackgroundErrors(), []);
  return { error, sequence, clearError: clearBackgroundError };
}
