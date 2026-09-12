import { useEffect, useSyncExternalStore } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBanner } from "@/components/app/ErrorNotice";
import { Sidebar } from "@/components/app/Sidebar";
import { View } from "@/components/app/View";
import { Feedback } from "@/components/app/views/Feedback";
import { Preferences } from "@/components/app/views/Preferences";
import { Sandbox } from "@/components/app/views/Sandbox";
import { Settings } from "@/components/app/views/Settings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getLocaleVersion, subscribeLocale } from "@/lib/i18n-runtime";
import { sendToBackground } from "@/lib/protocol";
import { HandoffBanner } from "@/migrations/handoff/Banner";

export function App() {
  // Translated strings are module state in i18n-runtime, invisible to React, so a locale change
  // must remount the tree. Keyed below MemoryRouter so the current view survives; unsaved view
  // state (credential drafts, open accordions) resets, as any outside click already does.
  const localeVersion = useSyncExternalStore(subscribeLocale, getLocaleVersion);

  useEffect(() => {
    // The session cache may be stale.
    sendToBackground("fetchVoices").catch(() => {});
  }, []);

  return (
    <MemoryRouter initialEntries={["/sandbox"]}>
      <TooltipProvider key={localeVersion} delayDuration={200}>
        {/* Fills the popup viewport; the height bound lives in index.html. */}
        <div className="flex h-full min-h-0 flex-col bg-page text-body">
          <HandoffBanner />
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
