import {
  Box,
  Github,
  HelpCircle,
  MessageSquarePlus,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { i18n } from "#i18n";
import { browser } from "#imports";
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
          "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
          isActive
            ? "bg-stone-200 text-stone-900"
            : "text-stone-700 hover:text-stone-900 hover:bg-stone-100",
        )
      }
    >
      <span className={cn("p-1 rounded text-white", color)}>{icon}</span>
      <span>{children}</span>
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <div className="flex flex-col min-w-40 max-w-52 p-2 py-2.5 border-r border-stone-200 shrink-0">
      <div className="flex items-center mb-3 mx-1 ml-2 gap-1.5">
        <img src="/icons/32.png" alt="" className="w-[26px] h-[26px]" />
        <div>
          <div className="text-base font-bold text-stone-800 leading-none">
            {i18n.t("app.name")}
          </div>
          <div className="text-xxs font-bold text-stone-500">{i18n.t("app.subtitle")}</div>
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
        <button
          type="button"
          className={cn(
            "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
            "text-stone-700 hover:text-stone-900 hover:bg-stone-100",
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
            "p-1 flex items-center gap-1.5 font-semibold rounded cursor-pointer transition-colors duration-150 w-full text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
            "text-stone-700 hover:text-stone-900 hover:bg-stone-100",
          )}
          onClick={() =>
            browser.tabs.create({ url: "https://github.com/vivswan/cloud-speech-for-chrome" })
          }
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
