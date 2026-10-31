import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { DeployButton } from '~/components/deploy/DeployButton';
import { publishedSites } from '~/lib/makelo/platform';
import { chatId } from '~/lib/persistence/useChatHistory';
import { workbenchStore } from '~/lib/stores/workbench';

interface HeaderActionButtonsProps {
  chatStarted: boolean;
}

const iconBtn =
  'p-2 rounded-lg text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors';

export function HeaderActionButtons({ chatStarted: _chatStarted }: HeaderActionButtonsProps) {
  const previews = useStore(workbenchStore.previews);
  const currentChat = useStore(chatId);
  const liveSite = useStore(publishedSites)[currentChat ?? ''];

  return (
    <div className="flex items-center gap-1.5">
      {liveSite && (
        <>
          <a
            href={liveSite.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2"
            title="Open live app"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="max-w-[200px] truncate">{liveSite.url.replace(/^https?:\/\//, '')}</span>
          </a>
          <button
            className={iconBtn}
            title="Copy link"
            onClick={() => {
              navigator.clipboard.writeText(liveSite.url).then(
                () => toast.success('Link copied'),
                () => toast.error('Could not copy the link'),
              );
            }}
          >
            <div className="i-ph:link-simple text-lg" />
          </button>
        </>
      )}
      {previews.length > 0 && <DeployButton />}
    </div>
  );
}
