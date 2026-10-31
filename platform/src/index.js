import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './server.js';

const config = loadConfig();
const { app } = createApp(config);

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`ClickMyApp platform on :${info.port}  app=${config.appHost}  sites=*.${config.sitesDomain}  data=${config.dataDir}`);
});
