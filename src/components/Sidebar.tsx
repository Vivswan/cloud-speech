import React, { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, GitHub, HelpCircle, Settings, Sliders } from 'react-feather'
import { twMerge } from 'tailwind-merge'

interface SidebarItemProps {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  children: ReactNode;
  to?: string;
  color: string;
  onClick?: () => void;
}

export function Sidebar() {
  return (
    <div className="flex flex-col w-56 p-2 py-2.5 border-r">
      <div className="flex items-center text-center mb-3 mx-1 ml-3">
        <img
          src="../assets/images/icon_1000.png"
          className="mr-1.5 pt-0.5"
          style={{ width: '26px' }}
        />
        <div>
          <div className="text-base font-bold text-neutral-800 bg-">
            Polly
          </div>
          <div
            className="text-xs font-bold text-neutral-500"
            style={{ fontSize: '10px', marginTop: '-5px' }}
          >
            for Chrome
          </div>
        </div>
      </div>
      <Sidebar.Item Icon={Box} color="bg-sky-500" to="/sandbox">
        Sandbox
      </Sidebar.Item>
      <Sidebar.Item Icon={Sliders} color="bg-green-500" to="/">
        Preferences
      </Sidebar.Item>
      <Sidebar.Item Icon={Settings} color="bg-orange-500" to="/settings">
        Settings
      </Sidebar.Item>
      <div className="mt-auto">
        <Sidebar.Item Icon={HelpCircle} color="bg-neutral-400" onClick={() => {
          const helpUrl = chrome.runtime.getURL('/help.html')

          chrome.tabs.create({ url: helpUrl })
        }}>
          Help Guide
        </Sidebar.Item>
        <Sidebar.Item
          Icon={GitHub}
          color="bg-neutral-600"
          to="https://github.com/vivswan/polly-for-chrome"
        >
          Contribute
        </Sidebar.Item>
      </div>
    </div>
  )
}

Sidebar.Item = function Item({ Icon, children, to, color, onClick }: SidebarItemProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const active = to ? location.pathname === to : false

  function handleClick() {
    if (to) {
      if (to.startsWith('http')) {
        chrome.tabs.create({ url: to })
        return
      }
      navigate(to)
    }
  }

  return (
    <button
      onClick={onClick || handleClick}
      className={twMerge(
        'p-1 flex items-center group font-semibold rounded cursor-pointer transition-all w-full',
        !active && 'text-neutral-700 hover:text-neutral-900',
        active && 'bg-neutral-200 bg-opacity-70 text-neutral-900'
      )}
    >
      <div className={`p-1 rounded mr-1.5 text-white ${color}`}>
        <Icon size={14} className="group-hover:animate-wiggle" />
      </div>
      <div>{children}</div>
    </button>
  )
}
