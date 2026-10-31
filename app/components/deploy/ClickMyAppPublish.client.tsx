import { useStore } from '@nanostores/react';
import { useState } from 'react';
import { toast } from 'react-toastify';
import { formatBuildFailureOutput } from './deployUtils';
import { accountUrl, bytesToBase64, PlatformError, platformUser, publishFiles } from '~/lib/clickmyapp/platform';
import { chatId, description } from '~/lib/persistence/useChatHistory';
import type { ActionCallbackData } from '~/lib/runtime/message-parser';
import { workbenchStore } from '~/lib/stores/workbench';
import { webcontainer } from '~/lib/webcontainer';
import { path } from '~/utils/path';

const OUTPUT_DIRS = ['/dist', '/build', '/out', '/output', '/web-build', '/public'];

/**
 * Builds the current project and publishes it to the user's free *.clickmyapp.com subdomain.
 * Works for web apps (Vite, Next static export, Astro, ...) and Expo mobile apps (web export).
 */
export function useClickMyAppPublish() {
  const [isPublishing, setIsPublishing] = useState(false);
  const currentChatId = useStore(chatId);
  const user = useStore(platformUser);

  const publish = async (): Promise<boolean> => {
    if (!user) {
      toast.info('Log in to ClickMyApp to publish your app.');
      window.location.href = accountUrl(`/account/login?next=${encodeURIComponent(window.location.pathname)}`);

      return false;
    }

    if (!currentChatId) {
      toast.error('Start a project first, then publish it.');
      return false;
    }

    const artifact = workbenchStore.firstArtifact;

    if (!artifact) {
      toast.error('No project found to publish.');
      return false;
    }

    setIsPublishing(true);

    workbenchStore.addArtifact({
      id: 'clickmyapp-publish',
      messageId: 'clickmyapp-publish',
      title: 'Publishing',
      type: 'standalone',
    });

    const alerts = workbenchStore.artifacts.get()['clickmyapp-publish'].runner;

    try {
      alerts.handleDeployAction('building', 'running', { source: 'clickmyapp' });

      const container = await webcontainer;

      // Expo (mobile) projects are published as their web version.
      let buildCommand = 'npm run build';

      try {
        const pkg = JSON.parse(await container.fs.readFile('/package.json', 'utf-8'));
        const isExpo = Boolean(pkg.dependencies?.expo);

        if (isExpo && !pkg.scripts?.build) {
          buildCommand = 'npx expo export --platform web --output-dir dist';
        } else if (isExpo && pkg.scripts?.['build:web']) {
          buildCommand = 'npm run build:web';
        }
      } catch {
        /* no package.json: plain static site */
      }

      const actionData: ActionCallbackData = {
        messageId: 'clickmyapp build',
        artifactId: artifact.id,
        actionId: `build-${Date.now()}`,
        action: { type: 'build' as const, content: buildCommand },
      };

      artifact.runner.addAction(actionData);
      await artifact.runner.runAction(actionData);

      const buildOutput = artifact.runner.buildOutput;

      if (!buildOutput || buildOutput.exitCode !== 0) {
        alerts.handleDeployAction('building', 'failed', {
          error: formatBuildFailureOutput(buildOutput?.output),
          source: 'clickmyapp',
        });
        throw new Error('Build failed — ask the AI to fix the build error, then publish again.');
      }

      alerts.handleDeployAction('deploying', 'running', { source: 'clickmyapp' });

      const reported = buildOutput.path.replace('/home/project', '');

      let root: string | null = null;

      for (const dir of [reported, ...OUTPUT_DIRS]) {
        try {
          const entries = await container.fs.readdir(dir);

          if (entries.includes('index.html')) {
            root = dir;
            break;
          }
        } catch {
          /* try the next folder */
        }
      }

      if (!root) {
        throw new Error('Could not find the built app (no index.html in dist/, build/ or out/).');
      }

      const files: Record<string, string> = {};

      const collect = async (dir: string) => {
        for (const entry of await container.fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await collect(full);
          } else if (entry.isFile()) {
            files[full.slice(root!.length) || '/'] = bytesToBase64(await container.fs.readFile(full));
          }
        }
      };

      await collect(root);

      const site = await publishFiles({
        name: description.get() || 'My app',
        chatId: currentChatId,
        files,
      });

      alerts.handleDeployAction('complete', 'complete', { url: site.url, source: 'clickmyapp' });
      toast.success(
        <div>
          Your app is live!{' '}
          <a href={site.url} target="_blank" rel="noopener noreferrer" className="underline">
            {site.url.replace(/^https?:\/\//, '')}
          </a>
        </div>,
        { autoClose: 10000 },
      );

      return true;
    } catch (err) {
      const message =
        err instanceof PlatformError && err.status === 401
          ? 'Your ClickMyApp login expired — log in again.'
          : err instanceof Error
            ? err.message
            : 'Publishing failed.';
      alerts.handleDeployAction('deploying', 'failed', { error: message, source: 'clickmyapp' });
      toast.error(message);

      return false;
    } finally {
      setIsPublishing(false);
    }
  };

  return { publish, isPublishing };
}
