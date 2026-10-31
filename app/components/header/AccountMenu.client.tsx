import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  accountUrl,
  loadPlatformUser,
  loadPublishedSites,
  PLATFORM_URL,
  platformUser,
  setAccessToken,
} from '~/lib/makelo/platform';

const linkClass =
  'px-3 py-1.5 text-xs rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive';

/** Login state + account links. Web uses the login cookie; desktop uses an access token. */
export function AccountMenu() {
  const user = useStore(platformUser);
  const [askToken, setAskToken] = useState(false);
  const [token, setToken] = useState('');
  const isDesktop = Boolean(PLATFORM_URL);

  useEffect(() => {
    loadPlatformUser().then((u) => u && loadPublishedSites());
  }, []);

  if (user === undefined) {
    return null;
  }

  if (!user) {
    if (isDesktop) {
      return askToken ? (
        <form
          className="flex gap-1 items-center"
          onSubmit={async (e) => {
            e.preventDefault();
            setAccessToken(token);

            if (await loadPlatformUser()) {
              loadPublishedSites();
              setAskToken(false);
              toast.success('Connected to your Makelo account.');
            } else {
              setAccessToken(null);
              toast.error('That token did not work. Create a new one on your Makelo dashboard.');
            }
          }}
        >
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste access token"
            className="px-2 py-1 text-xs rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary w-44"
          />
          <button className={linkClass}>Connect</button>
          <a className={linkClass} href={accountUrl('/account')} target="_blank" rel="noopener noreferrer">
            Get token
          </a>
        </form>
      ) : (
        <button className={linkClass} onClick={() => setAskToken(true)}>
          Connect Makelo account
        </button>
      );
    }

    const next = encodeURIComponent(window.location.pathname);

    return (
      <div className="flex gap-2 items-center">
        <a className={linkClass} href={`/account/login?next=${next}`}>
          Log in
        </a>
        <a className="px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white" href={`/account/signup?next=${next}`}>
          Sign up free
        </a>
      </div>
    );
  }

  return (
    <div className="flex gap-2 items-center">
      <a
        className={linkClass}
        href={accountUrl('/account')}
        target={isDesktop ? '_blank' : undefined}
        rel="noopener noreferrer"
      >
        My apps
      </a>
      <span
        className="hidden md:inline text-xs text-bolt-elements-textSecondary max-w-[160px] truncate"
        title={user.email}
      >
        {user.email}
      </span>
      {isDesktop ? (
        <button
          className={linkClass}
          onClick={() => {
            setAccessToken(null);
            platformUser.set(null);
          }}
        >
          Disconnect
        </button>
      ) : (
        <form method="post" action="/account/logout">
          <button className={linkClass}>Log out</button>
        </form>
      )}
    </div>
  );
}
