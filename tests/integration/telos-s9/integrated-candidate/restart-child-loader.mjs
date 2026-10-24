import { resolve as pathResolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
let root;
export function initialize(data) {
  root = data.root;
}
const externalSources = {
  'auto-rename.ts': `export const shouldAutoRename=()=>false; export const extractRecentPrompts=()=>[]; export const generateSessionNameFallback=()=> 'Offline restart'; export const generateSessionName=async()=>{throw Error('No model naming')}; export const createAnthropicClient=()=>{throw Error('No provider')}; export const setClientFactory=()=>{}; export const resetClientFactory=()=>{}; export const AUTO_RENAME_INTERVAL=0; export const AUTO_RENAME_MODEL='offline';`,
  'mcp-config.ts': `export const loadMcpServers=()=>({}); export const getMcpConfigPaths=()=>[]; export const loadFromFile=()=>({});`,
  'notify.ts': `export const isConfigured=()=>false; export const sendPermissionNotification=async()=>{}; export const sendTurnCompleteNotification=async()=>{};`,
  'pushover.ts': `export const isConfigured=()=>false; export const sendPushoverNotification=async()=>{}; export const sendPermissionNotification=async()=>{}; export const sendTurnCompleteNotification=async()=>{};`,
  'goal-client.ts': `export const createGoal=async()=>null; export const reportUsage=async()=>{}; export const deriveGoalTitle=()=> 'Offline'; export const resetAvailability=()=>{};`,
};
export async function resolve(specifier, context, next) {
  const aliases = {
    '@mitzo/protocol': 'packages/protocol/src/index.ts',
    '@mitzo/protocol/event-store': 'packages/protocol/src/event-store.ts',
    '@mitzo/protocol/database-backup': 'packages/protocol/src/database-backup.ts',
    '@mitzo/protocol/telos-sqlite-owners': 'packages/protocol/src/telos-sqlite-owners.ts',
    '@mitzo/protocol/collaboration-forward-custody':
      'packages/protocol/src/collaboration-forward-custody.ts',
    '@mitzo/harness': 'packages/harness/src/index.ts',
    '@mitzo/client': 'packages/client/src/index.ts',
  };
  return next(
    aliases[specifier] ? pathToFileURL(pathResolve(root, aliases[specifier])).href : specifier,
    context,
  );
}
export async function load(url, context, next) {
  for (const [name, source] of Object.entries(externalSources))
    if (url === pathToFileURL(join(root, 'server', name)).href)
      return { format: 'module', source, shortCircuit: true };
  return next(url, context);
}
