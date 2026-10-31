/**
 * One-off: build the ClickMyApp sandbox image on e2b.dev.
 *
 *   cd platform && E2B_API_KEY=e2b_... node scripts/build-e2b-template.js
 *
 * Then set E2B_TEMPLATE=clickmyapp-node in deploy/.env.
 * Re-run whenever you want newer Node / tools in users' sandboxes.
 */
import { Template, defaultBuildLogger } from 'e2b';

if (!process.env.E2B_API_KEY) {
  console.error('Set E2B_API_KEY first (from https://e2b.dev/dashboard).');
  process.exit(1);
}

const template = Template()
  .fromNodeImage('22')
  .aptInstall(['git', 'python3', 'python3-pip', 'python3-venv', 'procps', 'curl', 'unzip'])
  .runCmd(['npm install -g pnpm@9 yarn@1 --no-fund --no-audit', 'npm cache clean --force'], { user: 'root' });

const info = await Template.build(template, process.env.E2B_TEMPLATE || 'clickmyapp-node', {
  cpuCount: Number(process.env.E2B_CPUS || 2),
  memoryMB: Number(process.env.E2B_MEMORY_MB || 2048),
  onBuildLogs: defaultBuildLogger(),
});

console.log('\nBuilt template:', info.alias || info.name || info.templateId);
console.log('Add to deploy/.env:  E2B_TEMPLATE=' + (process.env.E2B_TEMPLATE || 'clickmyapp-node'));
