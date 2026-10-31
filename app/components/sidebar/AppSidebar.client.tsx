import { useStore } from '@nanostores/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import type { TabType } from '~/components/@settings/core/types';
import { DocumentationPanel } from '~/components/ui/DocumentationPanel';
import { ThemeSwitch } from '~/components/ui/ThemeSwitch';
import { accountUrl, PLATFORM_URL, platformUser, publishedSites } from '~/lib/makelo/platform';
import { chatId, db, deleteById, type ChatHistoryItem } from '~/lib/persistence';
import {
  pinnedProjects,
  recentProjects,
  refreshRecentProjects,
  SIDEBAR_RAIL,
  SIDEBAR_WIDTH,
  sidebarCollapsed,
  sidebarMobileOpen,
  toggleSidebar,
  togglePinned,
} from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';

const LazyControlPanel = lazy(() =>
  import('~/components/@settings/core/ControlPanel').then((m) => ({ default: m.ControlPanel })),
);

const MOBILE_QUERY = '(max-width: 1023px)';

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);

    return () => mq.removeEventListener('change', onChange);
  }, []);

  return mobile;
}

const navItem =
  'flex items-center gap-3 w-full rounded-lg px-2.5 py-2 text-[14px] text-bolt-elements-textPrimary bg-transparent hover:bg-bolt-elements-background-depth-3 transition-colors';

/** Makelo's persistent left sidebar: workspace, New, navigation, pinned + recent projects, account. */
export function AppSidebar() {
  const collapsedPref = useStore(sidebarCollapsed);
  const mobileOpen = useStore(sidebarMobileOpen);
  const isMobile = useIsMobile();
  const collapsed = !isMobile && collapsedPref;
  const projects = useStore(recentProjects);
  const pinned = useStore(pinnedProjects);
  const activeChat = useStore(chatId);
  const user = useStore(platformUser);
  const live = useStore(publishedSites);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [settingsTab, setSettingsTab] = useState<TabType | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);

  useEffect(() => {
    refreshRecentProjects();

    // Pick up projects created or renamed elsewhere (new chats, other tabs).
    const timer = setInterval(refreshRecentProjects, 4000);
    window.addEventListener('focus', refreshRecentProjects);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshRecentProjects);
    };
  }, []);

  // The workbench layout reads --sidebar-width to size itself next to the sidebar.
  useEffect(() => {
    const width = isMobile ? 0 : collapsed ? SIDEBAR_RAIL : SIDEBAR_WIDTH;
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  }, [collapsed, isMobile]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.description?.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  const pinnedItems = filtered.filter((p) => pinned.includes(p.id));
  const recentItems = filtered.filter((p) => !pinned.includes(p.id));

  const deleteProject = async (item: ChatHistoryItem) => {
    if (!db || !window.confirm(`Delete "${item.description}"? This can't be undone.`)) {
      return;
    }

    try {
      await deleteById(db, item.id);
      toast.success('Project deleted');

      if (activeChat === item.id || activeChat === item.urlId) {
        window.location.href = '/';
        return;
      }

      refreshRecentProjects();
    } catch {
      toast.error('Could not delete the project');
    }
  };

  const displayName = (user?.email || 'Guest').split('@')[0];
  const initial = displayName.charAt(0).toUpperCase();

  const body = (
    <aside
      className={classNames(
        'h-full flex flex-col bg-bolt-elements-background-depth-2 border-r border-bolt-elements-borderColor select-none',
        isMobile ? 'fixed inset-y-0 left-0 z-[300] shadow-2xl' : 'relative flex-shrink-0',
      )}
      style={{ width: collapsed ? SIDEBAR_RAIL : SIDEBAR_WIDTH }}
    >
      {/* Logo + search / collapse */}
      <div className={classNames('flex items-center h-[54px] px-3', collapsed ? 'justify-center' : 'justify-between')}>
        <a href="/" className="flex items-center gap-2" title="Makelo home">
          <img src="/makelo-mark.svg" alt="Makelo" className="w-7 h-7" />
          {!collapsed && <span className="font-bold text-[15px] text-bolt-elements-textPrimary">Makelo</span>}
        </a>
        {!collapsed && (
          <div className="flex items-center gap-0.5">
            <button
              title="Search projects"
              className="p-1.5 rounded-md bg-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3"
              onClick={() => setSearching((s) => !s)}
            >
              <div className="i-ph:magnifying-glass text-lg" />
            </button>
            <button
              title={isMobile ? 'Close menu' : 'Collapse sidebar'}
              className="p-1.5 rounded-md bg-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3"
              onClick={() => (isMobile ? sidebarMobileOpen.set(false) : toggleSidebar())}
            >
              <div className={isMobile ? 'i-ph:x text-lg' : 'i-ph:sidebar-simple text-lg'} />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto modern-scrollbar px-2 pb-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1 pt-1">
            <button
              title="Expand sidebar"
              className="p-2 rounded-lg bg-transparent hover:bg-bolt-elements-background-depth-3"
              onClick={toggleSidebar}
            >
              <div className="i-ph:sidebar-simple text-xl text-bolt-elements-textSecondary" />
            </button>
            <a href="/" title="New app" className="p-2 rounded-lg bg-accent-500 text-white">
              <div className="i-ph:plus-bold text-lg" />
            </a>
            <a href="/?import=1" title="Import" className="p-2 rounded-lg hover:bg-bolt-elements-background-depth-3">
              <div className="i-ph:download-simple text-xl text-bolt-elements-textSecondary" />
            </a>
            <a
              href="/?templates=1"
              title="Templates"
              className="p-2 rounded-lg hover:bg-bolt-elements-background-depth-3"
            >
              <div className="i-ph:squares-four text-xl text-bolt-elements-textSecondary" />
            </a>
            <a
              href={accountUrl('/account')}
              title="Published apps & domains"
              className="p-2 rounded-lg hover:bg-bolt-elements-background-depth-3"
            >
              <div className="i-ph:globe-simple text-xl text-bolt-elements-textSecondary" />
            </a>
          </div>
        ) : (
          <>
            {/* Workspace */}
            <div className="flex items-center gap-2.5 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2.5 py-2 mb-2">
              <span className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-600 to-blue-600 text-white text-sm font-semibold grid place-items-center">
                {initial}
              </span>
              <span className="text-[14px] font-medium text-bolt-elements-textPrimary truncate">
                Personal workspace
              </span>
            </div>

            <a
              href="/"
              className="flex items-center justify-center gap-2 w-full rounded-xl py-2 mb-3 text-[14px] font-semibold text-white bg-gradient-to-r from-violet-600 to-blue-600 hover:opacity-95 shadow-sm"
            >
              <div className="i-ph:plus-circle-fill text-lg" />
              New app
            </a>

            {searching && (
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects…"
                className="w-full mb-2 px-3 py-1.5 text-sm rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary outline-none focus:border-accent-500"
              />
            )}

            <nav className="flex flex-col gap-0.5 mb-4">
              <a href="/?import=1" className={navItem}>
                <div className="i-ph:download-simple text-lg text-bolt-elements-textSecondary" /> Import
              </a>
              <a href="/?templates=1" className={navItem}>
                <div className="i-ph:squares-four text-lg text-bolt-elements-textSecondary" /> Templates
              </a>
              <a
                href={accountUrl('/account')}
                target={PLATFORM_URL ? '_blank' : undefined}
                rel="noopener noreferrer"
                className={navItem}
              >
                <div className="i-ph:globe-simple text-lg text-bolt-elements-textSecondary" /> Published apps
              </a>
              <button className={navItem} onClick={() => setSettingsTab('connectors')}>
                <div className="i-ph:plugs-connected text-lg text-bolt-elements-textSecondary" /> Integrations
              </button>
              <button className={navItem} onClick={() => setDocsOpen(true)}>
                <div className="i-ph:question text-lg text-bolt-elements-textSecondary" /> Help
              </button>
            </nav>

            {pinnedItems.length > 0 && (
              <ProjectSection
                title="Pinned"
                items={pinnedItems}
                activeChat={activeChat}
                pinned={pinned}
                live={live}
                onDelete={deleteProject}
              />
            )}
            <ProjectSection
              title="Recent"
              items={recentItems}
              activeChat={activeChat}
              pinned={pinned}
              live={live}
              onDelete={deleteProject}
              empty={query ? 'No matching projects' : 'Your apps will appear here'}
            />
          </>
        )}
      </div>

      {/* Account */}
      <div
        className={classNames(
          'border-t border-bolt-elements-borderColor p-2 flex items-center',
          collapsed ? 'flex-col gap-2' : 'gap-2',
        )}
      >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex items-center gap-2 flex-1 min-w-0 rounded-lg px-1.5 py-1.5 bg-transparent hover:bg-bolt-elements-background-depth-3">
              <span className="w-8 h-8 flex-shrink-0 rounded-full bg-gradient-to-br from-violet-600 to-blue-600 text-white text-sm font-semibold grid place-items-center">
                {initial}
              </span>
              {!collapsed && <span className="text-[14px] text-bolt-elements-textPrimary truncate">{displayName}</span>}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="top"
              align="start"
              sideOffset={6}
              className="z-[400] min-w-[220px] rounded-xl p-1.5 bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor shadow-xl"
            >
              <div className="px-2.5 py-2 text-xs text-bolt-elements-textSecondary truncate">
                {user?.email || 'Not logged in'}
              </div>
              <DropdownMenu.Item asChild>
                <a
                  className="block px-2.5 py-2 text-sm rounded-lg text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 outline-none"
                  href={accountUrl('/account')}
                >
                  Account & published apps
                </a>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="px-2.5 py-2 text-sm rounded-lg text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 outline-none cursor-pointer"
                onSelect={() => setSettingsTab('settings')}
              >
                Settings
              </DropdownMenu.Item>
              <div className="flex items-center justify-between px-2.5 py-2 text-sm text-bolt-elements-textPrimary">
                Theme <ThemeSwitch />
              </div>
              {user && !PLATFORM_URL && (
                <form method="post" action="/account/logout">
                  <button className="w-full text-left px-2.5 py-2 text-sm rounded-lg text-red-500 hover:bg-bolt-elements-background-depth-3">
                    Log out
                  </button>
                </form>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          title="Settings"
          className="p-2 rounded-lg bg-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3"
          onClick={() => setSettingsTab('settings')}
        >
          <div className="i-ph:gear-six text-lg" />
        </button>
      </div>
    </aside>
  );

  return (
    <>
      {isMobile
        ? mobileOpen && (
            <>
              <div className="fixed inset-0 z-[299] bg-black/30" onClick={() => sidebarMobileOpen.set(false)} />
              {body}
            </>
          )
        : body}
      {settingsTab && (
        <Suspense fallback={null}>
          <LazyControlPanel open onClose={() => setSettingsTab(null)} initialTab={settingsTab} />
        </Suspense>
      )}
      <DocumentationPanel open={docsOpen} onClose={() => setDocsOpen(false)} />
    </>
  );
}

function ProjectSection({
  title,
  items,
  activeChat,
  pinned,
  live,
  onDelete,
  empty,
}: {
  title: string;
  items: ChatHistoryItem[];
  activeChat: string | undefined;
  pinned: string[];
  live: Record<string, { url: string }>;
  onDelete: (item: ChatHistoryItem) => void;
  empty?: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-3">
      <button
        className="flex items-center gap-1 px-2.5 py-1 text-[13px] bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
        onClick={() => setOpen((o) => !o)}
      >
        {title}
        <div className={classNames('i-ph:caret-down text-xs transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {items.length === 0 && empty && (
            <div className="px-2.5 py-2 text-xs text-bolt-elements-textTertiary">{empty}</div>
          )}
          {items.map((item) => {
            const active = activeChat === item.id || activeChat === item.urlId;
            const isPinned = pinned.includes(item.id);
            const site = live[item.id] || (item.urlId ? live[item.urlId] : undefined);

            return (
              <div
                key={item.id}
                className={classNames(
                  'group flex items-center gap-2 rounded-lg pl-2.5 pr-1 py-1.5 text-[14px]',
                  active
                    ? 'bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor shadow-sm'
                    : 'border border-transparent hover:bg-bolt-elements-background-depth-3',
                )}
              >
                <a
                  href={`/chat/${item.urlId}`}
                  className="flex items-center gap-2 flex-1 min-w-0"
                  title={item.description}
                >
                  <span className="relative flex-shrink-0">
                    <div className="i-ph:app-window text-[17px] text-bolt-elements-textSecondary" />
                    {site && (
                      <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-bolt-elements-background-depth-2" />
                    )}
                  </span>
                  <span className="truncate text-bolt-elements-textPrimary">{item.description}</span>
                </a>
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    title={isPinned ? 'Unpin' : 'Pin'}
                    className="p-1 rounded-md bg-transparent text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2"
                    onClick={() => togglePinned(item.id)}
                  >
                    <div className={isPinned ? 'i-ph:push-pin-slash text-sm' : 'i-ph:push-pin text-sm'} />
                  </button>
                  <button
                    title="Delete"
                    className="p-1 rounded-md bg-transparent text-bolt-elements-textSecondary hover:text-red-500 hover:bg-bolt-elements-background-depth-2"
                    onClick={() => onDelete(item)}
                  >
                    <div className="i-ph:trash text-sm" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
