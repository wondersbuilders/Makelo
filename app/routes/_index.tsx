import type { MetaFunction } from 'react-router';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import { FirstRunOnboarding } from '~/components/onboarding/FirstRunOnboarding';
import { AppSidebar } from '~/components/sidebar/AppSidebar.client';

export const meta: MetaFunction = () => {
  return [
    { title: 'Makelo' },
    { name: 'description', content: 'Build web and mobile apps by chatting with AI — Makelo' },
  ];
};

export const loader = () => Response.json({});

/**
 * Makelo builder: persistent sidebar + chat + workbench
 * Note: Settings functionality should ONLY be accessed through the sidebar menu.
 * Do not add settings button/panel to this landing page as it was intentionally removed
 * to keep the UI clean and consistent with the design system.
 */
export default function Index() {
  return (
    <div className="flex h-full w-full bg-bolt-elements-background-depth-1">
      <ClientOnly>{() => <AppSidebar />}</ClientOnly>
      <div className="flex flex-col h-full flex-1 min-w-0 relative">
        <Header />
        <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
      </div>
      <FirstRunOnboarding />
    </div>
  );
}
