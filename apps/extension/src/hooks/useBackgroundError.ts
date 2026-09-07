import { useEffect, useSyncExternalStore } from "react";
import {
  clearBackgroundError,
  getBackgroundError,
  listenForBackgroundErrors,
  subscribeBackgroundError,
} from "@/lib/background-error";
import type { ErrorPayload } from "@/lib/protocol";

/** The last error the background pushed (or a request it never answered),
 *  received while a component using this hook is mounted. */
export function useBackgroundError(): { error: ErrorPayload | null; clearError: () => void } {
  const error = useSyncExternalStore(subscribeBackgroundError, getBackgroundError);
  useEffect(() => listenForBackgroundErrors(), []);
  return { error, clearError: clearBackgroundError };
}
