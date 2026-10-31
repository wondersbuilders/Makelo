import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { AccountMenu } from './AccountMenu.client';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { PLATFORM_URL, platformUser } from '~/lib/clickmyapp/platform';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { chatStore } from '~/lib/stores/chat';
import { sidebarMobileOpen } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';

/** Slim project bar: project name on the left, publish + sharing on the right. Branding lives in the sidebar. */
export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center gap-2 px-3 lg:px-4 h-[var(--header-height)] border-b', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor bg-bolt-elements-background-depth-1': chat.started,
      })}
    >
      <button
        className="lg:hidden p-1.5 -ml-1 rounded-md text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2"
        title="Menu"
        onClick={() => sidebarMobileOpen.set(true)}
      >
        <div className="i-ph:list text-xl" />
      </button>

      {chat.started ? (
        <>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="i-ph:app-window-duotone text-xl text-accent-500 flex-shrink-0" />
            <span className="truncate font-medium text-[15px] text-bolt-elements-textPrimary">
              <ClientOnly>{() => <ChatDescription />}</ClientOnly>
            </span>
          </div>
          <ClientOnly>{() => <HeaderActionButtons chatStarted={chat.started} />}</ClientOnly>
        </>
      ) : (
        <span className="flex-1" />
      )}

      <ClientOnly>{() => <SignedOutActions />}</ClientOnly>
    </header>
  );
}

/** Account lives in the sidebar; the header only offers log in / connect when needed. */
function SignedOutActions() {
  const user = useStore(platformUser);

  if (user && !PLATFORM_URL) {
    return null;
  }

  if (user && PLATFORM_URL) {
    return null;
  }

  return (
    <div className="ml-1">
      <AccountMenu />
    </div>
  );
}
