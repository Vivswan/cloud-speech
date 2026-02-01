import React from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { Preferences } from "./views/Preferences";
import { Settings } from "./views/Settings";
import { Sandbox } from "./views/Sandbox";
import { Sidebar } from "./Sidebar";
import { View } from "./views/View";
import { useMount } from "../hooks/useMount";

export function App() {
	const navigate = useNavigate();

	useMount(() => {
		// This is required as extensions load the route as `/popup.html` by default
		navigate("/sandbox");

		// Fetch voices in-case the session has become invalid
		chrome.runtime.sendMessage({ id: "fetchVoices" });
	});

	return (
		<div style={{ width: 545 }} className="bg-neutral-50 bg-opacity-50 flex">
			<Sidebar />
			<View>
				<Routes>
					<Route path="/" element={<Sandbox />} />
					<Route path="/sandbox" element={<Sandbox />} />
					<Route path="/preferences" element={<Preferences />} />
					<Route path="/settings" element={<Settings />} />
				</Routes>
			</View>
		</div>
	);
}
