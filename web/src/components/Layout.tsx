import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Bluetooth,
  ChevronRight,
  FileText,
  FolderHeart,
  HardDrive,
  Home,
  Mic,
  Moon,
  NotebookPen,
  Settings,
  Smartphone,
  Star,
  Sun,
  Trash2,
  Upload,
  UserRound,
  MessageSquare,
  Workflow,
} from "@/components/icons";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { WorkspaceSearch } from "./WorkspaceSearch";
import { Brand } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { getRuntime, apiUrl, authenticatedHeaders } from "@/lib/runtime";
import { useTheme } from "@/hooks/useTheme";
import { buildInfo, buildLabel } from "@/lib/build-info";

const nav = [
  { to: "/", icon: FolderHeart, label: "Recordings" },
  { to: "/transcripts", icon: FileText, label: "Transcripts" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

const desktopNav = [
  { to: "/", icon: Home, label: "Home" },
  { to: "/recordings", icon: FolderHeart, label: "Recordings" },
  nav[1],
  { to: "/notes", icon: NotebookPen, label: "Documents" },
  { to: "/ai", icon: MessageSquare, label: "AI Chat" },
];

export function Layout() {
  const { dark, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const runtime = getRuntime();
  const [syncMessage, setSyncMessage] = useState("");
  const [recordingCount, setRecordingCount] = useState<number | null>(null);
  const clearMessageTimer = useRef<number | null>(null);
  const pageScrollRef = useRef<HTMLElement>(null);
  const captureMode = location.pathname === "/record";
  const libraryView =
    location.pathname === "/recordings"
      ? new URLSearchParams(location.search).get("view")
      : null;
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api
        .getStats()
        .then((stats) => {
          if (!disposed) setRecordingCount(stats.totalRecordings);
        })
        .catch(() => {});
    void load();
    window.addEventListener("plaud:sync-complete", load);
    return () => {
      disposed = true;
      window.removeEventListener("plaud:sync-complete", load);
    };
  }, []);

  useLayoutEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  useEffect(
    () => () => {
      if (clearMessageTimer.current)
        window.clearTimeout(clearMessageTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (runtime.mode === "mobile") return;
    let stopped = false,
      lastId: number | null = null;
    const poll = async () => {
      try {
        const response = await fetch(apiUrl("/plaud/auto-import"), {
          headers: authenticatedHeaders(),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return;
        const result = await response.json(),
          newest = result.data?.events?.[0]?.id ?? 0;
        if (!stopped && lastId !== null && newest > lastId) {
          setSyncMessage("Plaud recording safely stored in your vault");
          window.dispatchEvent(new CustomEvent("plaud:sync-complete"));
          if (clearMessageTimer.current)
            clearTimeout(clearMessageTimer.current);
          clearMessageTimer.current = window.setTimeout(
            () => setSyncMessage(""),
            6000,
          );
        }
        lastId = newest;
      } catch {
        /* Import errors remain visible in device settings. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runtime.mode]);

  const handleSync = () => navigate("/devices");

  return (
    <TooltipProvider>
      <div className="app-shell">
        <aside className="desktop-sidebar">
          <div className="sidebar-brand">
            <Brand />
          </div>
          <nav className="sidebar-nav" aria-label="Main navigation">
            {desktopNav.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `nav-item ${isActive && !(to === "/recordings" && libraryView) ? "active" : ""}`
                }
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
                {to === "/recordings" && recordingCount !== null && (
                  <small className="nav-count">{recordingCount}</small>
                )}
              </NavLink>
            ))}
            <NavLink
              to="/import"
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Upload />
              <span>Import</span>
            </NavLink>
            <NavLink
              to="/devices"
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Bluetooth />
              <span>Plaud Device</span>
            </NavLink>
            <Link
              to="/settings#pairing"
              aria-current={location.pathname === '/settings' && location.hash === '#pairing' ? 'page' : undefined}
              className={`nav-item ${location.pathname === "/settings" && location.hash === "#pairing" ? "active" : ""}`}
            >
              <Smartphone />
              <span>Android</span>
            </Link>
            <NavLink
              to="/developer"
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <Workflow />
              <span>API &amp; MCP</span>
            </NavLink>
          </nav>
          <div className="sidebar-actions">
            <Link
              to="/recordings?view=starred"
              aria-current={libraryView === 'starred' ? 'page' : undefined}
              className={`nav-item ${libraryView === "starred" ? "active" : ""}`}
            >
              <Star />
              <span>Starred</span>
            </Link>
            <Link
              to="/recordings?view=trash"
              aria-current={libraryView === 'trash' ? 'page' : undefined}
              className={`nav-item ${libraryView === "trash" ? "active" : ""}`}
            >
              <Trash2 />
              <span>Trash</span>
            </Link>
            <div className="vault-state">
              <HardDrive />
              {runtime.mode === "desktop"
                ? "Local recording vault"
                : "OpenPlod workspace"}
            </div>
            <NavLink to="/settings" className="workspace-profile">
              <span className="profile-avatar">
                <UserRound />
              </span>
              <span>
                Local workspace<small>Settings</small>
              </span>
              <ChevronRight />
            </NavLink>
          </div>
        </aside>

        <div className="app-content">
          {!captureMode && (
            <header className="workspace-bar">
              <WorkspaceSearch />
              <div className="workspace-bar-actions">
                <Button
                  className="workspace-new"
                  size="sm"
                  onClick={() => navigate("/record")}
                >
                  <Mic />
                  New recording
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={toggle}
                      aria-label={dark ? "Use light mode" : "Use dark mode"}
                    >
                      {dark ? <Sun /> : <Moon />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {dark ? "Light mode" : "Dark mode"}
                  </TooltipContent>
                </Tooltip>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Notifications"
                      title="Notifications"
                    >
                      <Bell />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="action-menu notification-menu"
                      align="end"
                    >
                      <DropdownMenu.Label>Notifications</DropdownMenu.Label>
                      <p>
                        {syncMessage || "No new notifications this session."}
                      </p>
                      <DropdownMenu.Item onSelect={() => navigate("/devices")}>
                        Device activity
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </header>
          )}
          {!captureMode && (
            <header className="mobile-header">
              <Brand />
              <div className="flex items-center gap-1">
                <Button asChild variant="ghost" size="icon" className="h-9 w-9">
                  <NavLink
                    to="/settings"
                    aria-label="Settings"
                    title="Settings"
                  >
                    <Settings className="h-4 w-4" />
                  </NavLink>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={handleSync}
                  aria-label="Open Plaud"
                  title="Open Plaud"
                >
                  <Bluetooth className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={toggle}
                  aria-label={dark ? "Use light mode" : "Use dark mode"}
                  title={dark ? "Use light mode" : "Use dark mode"}
                >
                  {dark ? (
                    <Sun className="h-4 w-4" />
                  ) : (
                    <Moon className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </header>
          )}

          {syncMessage && (
            <div className="sync-toast" role="status">
              {syncMessage}
            </div>
          )}
          <main
            ref={pageScrollRef}
            className={
              captureMode ? "page-scroll capture-scroll" : "page-scroll"
            }
          >
            <Outlet />
          </main>
          {!captureMode && (
            <footer className="workspace-footer">
              <div>
                <Brand />
              </div>
              <div className="workspace-footer-links">
                <span title={`OpenPlod ${buildInfo.version} / ${buildInfo.builtAt}`}>
                  <i />
                  Build {buildLabel}
                </span>
                <Smartphone />
                <NavLink to="/developer">API</NavLink>
                <NavLink to="/developer">MCP</NavLink>
                <a
                  href="https://github.com/RemiPelloux/OpenPlod"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub
                </a>
              </div>
            </footer>
          )}

          {!captureMode && (
            <nav className="mobile-nav" aria-label="Main navigation">
              {[
                nav[0],
                { to: "/notes", icon: NotebookPen, label: "Documents" },
              ].map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) =>
                    `mobile-nav-item ${isActive ? "active" : ""}`
                  }
                >
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
                </NavLink>
              ))}
              <button
                className="capture-action"
                type="button"
                onClick={() => navigate("/record")}
                aria-label="Record audio"
                title="Record audio"
              >
                <Mic />
              </button>
              <NavLink
                to="/ai"
                className={({ isActive }) =>
                  `mobile-nav-item mobile-nav-settings ${isActive ? "active" : ""}`
                }
              >
                <MessageSquare aria-hidden="true" />
                <span>AI</span>
              </NavLink>
              <NavLink
                to="/devices"
                className={({ isActive }) =>
                  `mobile-nav-item ${isActive ? "active" : ""}`
                }
              >
                <Bluetooth aria-hidden="true" />
                <span>Plaud</span>
              </NavLink>
            </nav>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
