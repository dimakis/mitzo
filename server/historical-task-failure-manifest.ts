/** Exact reviewed historical failures. Opaque digests avoid publishing task inputs,
 * outputs, session IDs or grant data. These are not reusable recovery grants.
 * The source audit establishes seven returned foreground failures and one
 * pre-publication commit refusal. Unknown result rows remain unchanged. */
export const reviewedHistoricalTaskFailures: readonly string[] = Object.freeze([
  '531d3ea59df8ce2e37471f40fa431a409aa4fcfb1bb37368a8b63c4c8b9dde1e',
  '66076ae15a723e111c2aabf50c235d0bc70661341d9379f97dbdf5b65d08f704',
  'a3ab72ea3f857f8bf94308ad15c309fdc2dbe5e160211f50cf137c86a3546c9c',
  '13fd7475dc4f16a7b96e914f039a0025364983352452b28d7ba960b78241c8ef',
  '8d3d9e97a7082e94958cb98cdb9ed3b14c05b2f04966d784e9568c0ac028bf0e',
  'c3e1ecb44df69f23b43fd031db4d2e26c401b5917fd9d50df9f69fb455259de1',
  '60ec937a2494233225346afe970895ebcaffe900e3cd4cadbcc3b295bd7d9222',
  '6434356219271581d88785dc61ba3dc354c246e5ad97ea23339fe70928e61071',
]);
export const reviewedHistoricalTaskSources = Object.freeze({
  'server/task-execution-operation.ts':
    'db40b0f5e9ae087cd745a36359dfd0df11a7ae2838465932d056ddee85a5ee3d',
  'server/task-execution-tools.ts':
    '92070e0506441866e98efacdffccf7c78a7732deca9f65f799faecc59f3bd193',
  'server/task-execution-store.ts':
    '356775fe62030f84d0ba2c01e607f2bd202399f1efab997fe69d0dc796191598',
  'server/native-tool-executor.ts':
    'd47f7607ac2b5e4481e22a56879bc47996e3c237fb2907d2883a9563b862a218',
  'server/sandboxed-command.ts': '315d8e779d3ba48a0cf45380e4b648254697a00dfbaa3c1887706534d0cbed3f',
  'server/trusted-native-operation.ts':
    '9d633906c3518694407e0c4965569e68cc0d5896d048c2e09ecb14452604108d',
  'server/turn-callbacks.ts': '0bff6978aa017fc99ff1d3b217c82be962c0a6090c875747c0cb0d9465af3aab',
});
