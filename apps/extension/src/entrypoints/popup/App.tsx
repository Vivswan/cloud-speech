import { X } from "lucide-react";
import { useEffect } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { i18n } from "#i18n";
import { MigrationBanner } from "@/components/app/MigrationBanner";
import { Sidebar } from "@/components/app/Sidebar";
import { View } from "@/components/app/View";
import { Feedback } from "@/components/app/views/Feedback";
import { Preferences } from "@/components/app/views/Preferences";
import { Sandbox } from "@/components/app/views/Sandbox";
import { Settings } from "@/components/app/views/Settings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sendToBackground } from "@/lib/messages";
import { usePlayerStore } from "@/stores/player";

/** Global error strip: background failures (synthesis, previews) land here so
 *  no error is ever silent, whatever view is open. */
function ErrorBanner() {
  const lastError = usePlayerStore((s) => s.lastError);
  const clearError = usePlayerStore((s) => s.clearError);
  if (!lastError) return null;

  return (
    <div className="flex items-start gap-2 border-b border-danger-edge bg-danger-surface px-3 py-2 text-xs text-danger">
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{lastError.title}</span>{" "}
        <span className="break-words">{lastError.message}</span>
      </div>
      <button
        type="button"
        title={i18n.t("common.dismiss")}
        className="shrink-0 cursor-pointer rounded p-0.5 text-danger/70 hover:bg-danger-edge/40 hover:text-danger"
        onClick={clearError}
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function App() {
  const refresh = usePlayerStore((s) => s.refresh);

  useEffect(() => {
    // Refresh voices in case the session cache is stale + sync player state.
    sendToBackground("fetchVoices").catch(() => {});
    refresh();
  }, [refresh]);

  return (
    <MemoryRouter initialEntries={["/sandbox"]}>
      <TooltipProvider delayDuration={200}>
        {/* Fills the popup viewport; the height bound lives in index.html. */}
        <div className="flex h-full min-h-0 flex-col bg-page text-body">
          <MigrationBanner />
          <ErrorBanner />
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <View>
              <Routes>
                <Route path="/" element={<Navigate to="/sandbox" replace />} />
                <Route path="/sandbox" element={<Sandbox />} />
                <Route path="/preferences" element={<Preferences />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/feedback" element={<Feedback />} />
              </Routes>
            </View>
          </div>
        </div>
      </TooltipProvider>
    </MemoryRouter>
  );
}
