import { GITHUB_REPO_URL } from "@cloud-speech/constants";
import {
  Box,
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
import { browser } from "#imports";
import { useSettings } from "@/hooks/useSettings";
import { cn } from "@/lib/cn";
import { homepageUrl } from "@/lib/guide";
import { getActiveLocale, i18n } from "@/lib/i18n-runtime";

interface ItemProps {
  icon: ReactNode;
  color: string;
  to: string;
  children: ReactNode;
}

/** GitHub octocat mark; lucide-react 1.x removed its brand icons. */
function GithubIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
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
          onClick={() => browser.tabs.create({ url: homepageUrl(getActiveLocale()) })}
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
            <GithubIcon size={14} />
          </span>
          <span>GitHub ↗</span>
        </button>
      </div>
    </div>
  );
}
