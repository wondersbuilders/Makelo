import { atom } from 'nanostores';
import { db, getAll, type ChatHistoryItem } from '~/lib/persistence';

const COLLAPSED_KEY = 'clickmyapp-sidebar-collapsed';
const PINNED_KEY = 'clickmyapp-pinned-projects';

export const SIDEBAR_WIDTH = 248;
export const SIDEBAR_RAIL = 60;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const isBrowser = typeof window !== 'undefined';

/** Collapsed = icon rail only. */
export const sidebarCollapsed = atom<boolean>(isBrowser ? readJson(COLLAPSED_KEY, false) : false);

/** Drawer open state on small screens. */
export const sidebarMobileOpen = atom<boolean>(false);

/** Chat (project) ids pinned to the top of the sidebar. */
export const pinnedProjects = atom<string[]>(isBrowser ? readJson(PINNED_KEY, []) : []);

/** Projects (chats) newest first. */
export const recentProjects = atom<ChatHistoryItem[]>([]);

export function toggleSidebar() {
  const next = !sidebarCollapsed.get();
  sidebarCollapsed.set(next);
  writeJson(COLLAPSED_KEY, next);
}

export function togglePinned(id: string) {
  const current = pinnedProjects.get();
  const next = current.includes(id) ? current.filter((x) => x !== id) : [id, ...current];
  pinnedProjects.set(next);
  writeJson(PINNED_KEY, next);
}

export async function refreshRecentProjects() {
  if (!db) {
    return;
  }

  try {
    const list = await getAll(db);
    recentProjects.set(
      list
        .filter((item) => item.urlId && item.description)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    );
  } catch (err) {
    console.error('[sidebar] failed to load projects', err);
  }
}

/** "13 hours ago" style labels. */
export function timeAgo(value: string | number | Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));

  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];

  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }

  return 'just now';
}
