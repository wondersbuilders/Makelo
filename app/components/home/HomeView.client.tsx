import { useStore } from '@nanostores/react';
import { platformUser, publishedSites } from '~/lib/clickmyapp/platform';
import { recentProjects, timeAgo } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';

const SUGGESTIONS: { icon: string; color: string; label: string; prompt: string }[] = [
  {
    icon: 'i-ph:device-mobile-camera-fill',
    color: 'text-violet-500',
    label: 'Build a mobile app',
    prompt: 'Build a mobile app (Expo) for booking appointments with a calendar, reminders and a profile screen.',
  },
  {
    icon: 'i-ph:storefront-fill',
    color: 'text-emerald-500',
    label: 'Create an online shop',
    prompt: 'Create an online shop with product listings, a cart, checkout page and an admin page to add products.',
  },
  {
    icon: 'i-ph:chart-line-up-fill',
    color: 'text-blue-500',
    label: 'Make a business dashboard',
    prompt: 'Make a business dashboard with revenue charts, a customers table with search, and KPI cards.',
  },
  {
    icon: 'i-ph:rocket-launch-fill',
    color: 'text-orange-500',
    label: 'Design a landing page',
    prompt: 'Design a modern landing page for my startup with a hero section, features, pricing and a contact form.',
  },
];

/** Gradient + initial "thumbnail" so every project card has a recognisable face. */
const GRADIENTS = [
  'from-violet-500 to-blue-500',
  'from-emerald-500 to-teal-600',
  'from-orange-400 to-rose-500',
  'from-sky-500 to-indigo-600',
  'from-fuchsia-500 to-purple-600',
  'from-amber-400 to-orange-600',
];

function hash(text: string) {
  let h = 0;

  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }

  return Math.abs(h);
}

export function HomeRecent() {
  const projects = useStore(recentProjects).slice(0, 3);
  const live = useStore(publishedSites);

  if (projects.length === 0) {
    return null;
  }

  return (
    <section className="w-full max-w-[880px] mx-auto px-2 sm:px-6 pt-10 lg:pt-14 box-content">
      <h2 className="text-[15px] font-medium text-bolt-elements-textSecondary mb-3">Recent</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((p) => {
          const name = p.description || 'Untitled app';
          const site = live[p.id] || (p.urlId ? live[p.urlId] : undefined);

          return (
            <a
              key={p.id}
              href={`/chat/${p.urlId}`}
              className="group rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all"
            >
              <div
                className={classNames(
                  'h-[120px] bg-gradient-to-br flex items-center justify-center relative',
                  GRADIENTS[hash(name) % GRADIENTS.length],
                )}
              >
                <span className="text-white/95 text-4xl font-bold drop-shadow-sm">{name.charAt(0).toUpperCase()}</span>
                <div className="absolute inset-x-3 bottom-0 h-6 rounded-t-lg bg-white/25 backdrop-blur-sm" />
              </div>
              <div className="px-4 py-3">
                <div className="text-[15px] font-medium text-bolt-elements-textPrimary truncate">{name}</div>
                <div className="flex items-center gap-1.5 mt-1 text-[13px] text-bolt-elements-textSecondary">
                  {site ? (
                    <>
                      <span className="i-ph:globe-simple text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">Published</span>
                      <span>·</span>
                    </>
                  ) : (
                    <span className="i-ph:pencil-simple-line" />
                  )}
                  <span>{timeAgo(p.timestamp)}</span>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

export function HomeGreeting({ onPick }: { onPick: (prompt: string) => void }) {
  const user = useStore(platformUser);
  const name = user?.email ? user.email.split('@')[0].split(/[._-]/)[0] : '';

  return (
    <div className="w-full mx-auto px-1 mb-4">
      <h1 className="text-[28px] lg:text-[34px] leading-tight font-semibold text-bolt-elements-textPrimary mb-4">
        {name ? `${name}, what are we building today?` : 'What are we building today?'}
      </h1>
      <div className="text-[13px] text-bolt-elements-textSecondary mb-2">Suggested for you</div>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.prompt)}
            className="flex items-center gap-2 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3.5 py-2 text-[14px] text-bolt-elements-textPrimary shadow-sm hover:border-accent-500/60 hover:bg-bolt-elements-background-depth-2 transition-colors"
          >
            <span className={classNames(s.icon, s.color, 'text-base')} />
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Soft brand glow behind the home prompt. */
export function HomeBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] -z-0 bg-gradient-to-t from-violet-300/50 via-blue-200/25 to-transparent dark:from-violet-700/25 dark:via-blue-900/10"
    />
  );
}
