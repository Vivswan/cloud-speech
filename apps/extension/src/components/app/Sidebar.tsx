import { GITHUB_REPO_URL } from "@cloud-speech/constants";
import {
  Box,
  Github,
  HelpCircle,
  MessageSquarePlus,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { i18n } from "#i18n";
import { browser } from "#imports";
import { useSettings } from "@/hooks/useSettings";
import { cn } from "@/lib/cn";
import { homepageUrl } from "@/lib/guide";

interface ItemProps {
  icon: ReactNode;
  color: string;
  to: string;
  children: ReactNode;
}

function Item({ icon, color, to, children }: ItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
          isActive ? "bg-fill text-strong" : "text-body hover:text-strong hover:bg-inset",
        )
      }
    >
      <span className={cn("p-1 rounded text-white", color)}>{icon}</span>
      <span>{children}</span>
    </NavLink>
  );
}

const THEME_CYCLE = ["system", "light", "dark"] as const;

const THEME_ICONS = {
  system: <Monitor size={14} />,
  light: <Sun size={14} />,
  dark: <Moon size={14} />,
} as const;

const THEME_LABEL_KEYS = {
  system: "preferences.theme_system",
  light: "preferences.theme_light",
  dark: "preferences.theme_dark",
} as const;

/** Cycles system → light → dark; the same setting as the Preferences select. */
function ThemeToggle() {
  const { ready, settings, update } = useSettings();
  const theme = settings?.theme ?? "system";

  return (
    <button
      type="button"
      disabled={!ready}
      title={i18n.t("preferences.theme")}
      className={cn(
        "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
        "text-body hover:text-strong hover:bg-inset",
      )}
      onClick={() => {
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
        if (next) void update({ theme: next });
      }}
    >
      <span className="p-1 rounded text-white bg-amber-500">{THEME_ICONS[theme]}</span>
      <span>{i18n.t(THEME_LABEL_KEYS[theme])}</span>
    </button>
  );
}

export function Sidebar() {
  return (
    <div className="flex flex-col min-w-40 max-w-52 p-2 py-2.5 border-r border-edge shrink-0">
      <div className="flex items-center mb-3 mx-1 ml-2 gap-1.5">
        <img src="/icons/32.png" alt="" className="w-[26px] h-[26px]" />
        <div>
          <div className="text-base font-bold text-body leading-none">{i18n.t("app.name")}</div>
          <div className="text-xxs font-bold text-muted">{i18n.t("app.subtitle")}</div>
        </div>
      </div>

      <Item icon={<Box size={14} />} color="bg-brand" to="/sandbox">
        {i18n.t("sidebar.sandbox")}
      </Item>
      <Item icon={<SlidersHorizontal size={14} />} color="bg-violet-500" to="/preferences">
        {i18n.t("sidebar.preferences")}
      </Item>
      <Item icon={<Settings size={14} />} color="bg-blue-600" to="/settings">
        {i18n.t("sidebar.settings")}
      </Item>

      <div className="mt-auto flex flex-col gap-0.5">
        <ThemeToggle />
        <button
          type="button"
          className={cn(
            "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
            "text-body hover:text-strong hover:bg-inset",
          )}
          onClick={() => browser.tabs.create({ url: homepageUrl() })}
        >
          <span className="p-1 rounded text-white bg-teal-600">
            <HelpCircle size={14} />
          </span>
          <span>{i18n.t("sidebar.help")}</span>
        </button>
        <Item icon={<MessageSquarePlus size={14} />} color="bg-rose-500" to="/feedback">
          {i18n.t("sidebar.feedback")}
        </Item>
        <button
          type="button"
          className={cn(
            "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-strong",
            "text-body hover:text-strong hover:bg-inset",
          )}
          onClick={() => browser.tabs.create({ url: GITHUB_REPO_URL })}
        >
          <span className="p-1 rounded text-white bg-stone-700">
            <Github size={14} />
          </span>
          <span>GitHub ↗</span>
        </button>
      </div>
    </div>
  );
}
