import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.9';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.42';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../symposium-host-tool-bridge.ts':
    '93559b7b6a5aeb1e66e633d2038cedd774d1a9efe1e8bbfc20d83c7e13326ba0',
  '../symposium-seat-authorization.ts':
    '26006d392e10e68c695e00039935332c28fb7146feaa057e482afa38c4f1fa21',
  '../chat.ts': 'd4a36bcd0fe373ae5e4ee0d10f617fbb33f650b0081c8ffcc0a44e5f20d471b7',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../app.ts': '65b5b84c81a572b80c71a28d09e00b62791d045324795f2465e63f6a299fdb50',
  '../ws-handler-v2.ts': '2952b6ea0ad4307739603901b01725514896452ea70c9f2464d8c04c6f4d9052',
  '../codex-queue-routes.ts': '6873ee90c32da94dcfebd432535d4170942e53c980456927f9dd57e9917d9a53',
  '../agent-context-compiler.ts':
    '8abe66bbdb73b72493905dbd165637c9838555280b81d4b07cf2d32a383d845d',
  '../../packages/protocol/src/agent-context-recipe.ts':
    '05ca755108920256b95d1bf051b9937bfdd3fb0e745c64d3ff033a82d89c6289',
  '../symposium-director-routes.ts':
    'e6cabfe7555434bbf426209e5a0de750195559e106b0bbb09c4885a34159ff36',
  '../agent-library-binding.ts': '21fccbe6ee53ec292f93be9de3f678b3e1d4e8a8d6e83798678e9da44fadf7fb',
  '../agent-library-transport.ts':
    '2211de0127965af69a78d49576f1c91d282be04b40654428bc5c8a2a053e8479',
  '../agent-library-store.ts': 'fac60510d3a4b45aa34777daf885142e067538726104c749f4ebe533861472c7',
  '../agent-library-router.ts': '0b34aeca9c7894a3dd4cfa9ad9b930c20e5b54c30010b18c0553dd7dd1b6cc61',
  '../agent-library-runtime.ts': 'cc3be2fc2f61053d4430960a2328d41146463fdca701840a92ab65a89b29922d',
  '../agent-library-prompt.ts': '3be39c6cd2fb12c744c5f53e45b8c8b306398146edfcb2af479d4fa1c9159c28',
  '../symposium-profile-portability.ts':
    'aadefe0eab442dc27ce68b86654291299dc6664a185b903af44756f79ff26680',
  '../symposium-profiles.ts': '4138fce2cc44220fa90b3ef65b207b89c06a5f02cd24750a748f79d84d297c95',
  '../symposium-custodian-protocol.ts':
    'c9ce7f03cb6ba33befd7218ceba1e2bf8212b88e0195faa8a058697d352008ad',
  '../symposium-custodian-proxy.ts':
    'b89fd74b04bdc4375fb7996c06c1c8cc354e6cd75419c916a193db9881022ecb',
  '../../packages/protocol/src/agent-library.ts':
    'e5c0e87a605c4f7664d5b9c69411bafc8059301a8c37a8057d3bdf14f604900e',
  '../../packages/protocol/src/symposium.ts':
    '19e2192db110e0fdc3c4c47a2c8424c1614dab48dcbd92161ff2730896cd2c79',
  '../repository-chat-tools.ts': '2b3c9c950c38fe2b94bac06d69fff2560eacf2d43b2240e31232f351b9c7d441',
  '../repository-task-copy.ts': 'cd15f77cfa45883556d10536296a28f7451d2259a5a3eb2a9aeb807d24c54d6d',
  '../credential-connection-schema.ts':
    '3489ff131cd0bc28de23d85e1ed7cd4749fcb12f062bdc76407bedc0efe28f47',
  '../credential-setup.ts': '51c500c8c54b4b737751e8e41a844bd5ef48fec53f699916812bc4612a0044f7',
  '../connection-guide.ts': '00a8527ff4b84bcc110189e0e2bf4377abaefe4ec9adecf0bf8a19e350017c7d',
  '../credential-setup-continuation.ts':
    '6cb81428bb08fa2cf6b79e762573e34dc87f281cfc5d0be70b5316ce66fdd493',
  '../credential-setup-application.ts':
    '387ae34d23260d5e27a9585860210b157aa0ad23543eb13e70fc46496c5dbfb7',
  '../github-repository-connections.ts':
    '3917a36a0cc8b3bb73f1f4fa66e93e17be3b0ace58eff2bb3e0470bd67b7c11e',
  '../credential-websocket.ts': '87a41d7c329dccb6616726feed14a5fb25c8aefe94556c767f42618b8d995810',
  '../home-assistant-dashboard.ts':
    '1053d482935af066472aedd48365af2b71cb7cf55e30ee88cc9fcf89b96e1d62',
  '../credential-connections.ts':
    'bbdc3c9cb04e298c5f26bc705ce06348ce206fd8b72d83738dd6aef98bd0df5f',
  '../credential-connections-router.ts':
    '6d7b779ff5ba148b6aea43483f4003da0d9ed4908e551a273de5906140c7b96b',
  '../credential-connection-tools.ts':
    'ee8e9c3fa52f9fdac094fb80928f79c1d6df82a99fe60cc3673d8d27a8bceddb',
  '../credential-connections-runtime.ts':
    '89a1cdf4bd50c73a0aecfb966303fb37e0f524da9fb977478602c9c198a51b4d',
  '../credential-http.ts': 'fb584d92840e2ee34167fd354d7249cfb3144b321f0d3a0a4aad3015231fa22d',
  '../credential-redaction.ts': '817dda948c419deb064bc4c5298e034e5a0343972b4bf724fb6aaa869cf34403',
  '../credential-sdk-tools.ts': '74dcd0eb121566efcafcc4c80202cc14ffa36b44584895567980ef810914a4e7',
  '../session-credential-tools.ts':
    '8e73ab5ffe09a00991dacca2072bbe0accb2065efa5773166a7b63041317b49e',
  'policy-compiler.ts': '59579f9eb69a3129dd2d8e1676fa46bd21da45c07f58752183416c82c0986014',
  'registry.ts': 'd93c4b41cff1d0519dbdcbb466a035cc256b7bcc63d2e1440e781cda64833561',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  'capabilities/github-publish-pr.ts':
    '559e98cf8f45313e37bf34b4f54c4345bdc9b4bf22538078dc563483750bbde1',
  'capabilities/github-publish-pr-transport.ts':
    '503c887848f3180647b6188ab65b8503bc6670291d4ce865a1b1df1504f15293',
  '../github-host-source.ts': '2720dd0fedf081780ebd64a485164ec5abc6dee7920de925d35e3e6aa647e084',
  '../github-publishing-tool.ts':
    'a3df58f0c68bdf72433f5a88d425d35764092c6f6e1fbd62691ef865b9622326',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  '../openai-key-management.ts': '3f9217677809a041042a598434aaec619a636f3e0b6fb15aa46953480c11b667',
  '../openai-key-operation-store.ts':
    '53aa481b64f0b7cbb6055d3d0bd569bb4dc4cd55cf6807748e99a63cc66f20ed',
  '../openai-enrollment-models.ts':
    '11a318042fbd8f7aecc09563c80456bfff424813a3d12a05d01bc768a0358263',
  '../openai-account-enrollment.ts':
    '610827421850db26976f2e9a6c8552ea984e0b9bbd61621573fdb0f8fb0847f6',
  '../openai-account-enrollment-keychain.ts':
    '8bd52d66fc18bb9a573b3602f20eff4fdbdd9194ced1f30246d39584f4076cbe',
  '../openai-provider-enrollment-gateway.ts':
    '55f91240860c2f15d60a9fa491374cf74f30e06a4dbf75ec5ce6f321b9815991',
  '../openshell-key-api.ts': '45164e44c19a0d1c845a847ea3ccae625445d75c3d09fa32ca5ec86dd53e26a3',
  '../openshell-key-api-protocol.ts':
    '3ebca322e76e76771aaffbccabeda9ea1bb2945d672d9f9879d2665b584ca423',
  '../openai-key-gateway.ts': '8469d53784b79310006723b25004cb60ec90d24220961e20c6d7eb1b019e0363',
  '../keychain-rotation-credentials.ts':
    '4c36d9edaca72c0fc2009032656cf2254b4f3c2fafbd4cf771fbe980944c0ba2',
  '../keychain-vault.ts': '17a32a4e63621d623937033237cb10b6f1f87a30b0d88db5cd31888cbc4ce5a4',
  '../keychain-controller.ts': 'f5ecb380e2d6381ef8a0aedbb5e13ef2b5e551f8a245732a15dbd935abb8d449',
  '../keychain-helper-authority.ts':
    '1cdbc860589a90c531a9af779282c062bfcd4c1fb47f247374d0ca964593686d',
  '../../native/keychain-helper/main.swift':
    '316b7aaac1027f7f94d26e093edbe39a3ccac64236bd61702c32c47419f6edb1',
  '../openai-key-controller.ts': '721a1c6a513fc5380e4a2222927cda025bf8cbd7e8d49d8c5d526470e2cff217',
  '../connections-router.ts': '6620ec153b72f42b18370bc375ab88331205ac9eb8c4ccd9a1bfe7655646599b',
  '../connections-service.ts': '1aae9d2c0da483ae798ba03d5804bfb0e81316f3f69666c6595befec3179c314',
  '../git-branch.ts': '6dd4fef0069e65d78fc94d047777442e4ef073596555581da536e1e39a5d3877',
  '../github-repository-source.ts':
    'b9a6ef89472b001cb8cd8f8bc04c3b31d514980d9a5154cd6ad48c5b30d42c09',
  '../worktree.ts': 'e3fd6d93d33cb5403786c5a7da16dd229d8ba03ad06e8c3abaf6309c64adb34a',
  '../repository-task-checkout.ts':
    '32fd232781b0ba9573fa0e6a511a78ede54a8c33a80dee30f52d06283b4beab5',
  '../native-tool-executor.ts': '6bca4beb98690334e83a0a88b35c80558ed01b7485f682aca0cc0af11b6cd766',
  '../repository-workspaces.ts': 'b7e8cd755cdf6483d706f41d5deca216736b40dbd7863a3be20edfd32abb811c',
  '../../packages/protocol/src/event-store.ts':
    '432705361699b5a44405c531ac171e4e87f521371f0312497b6ba7a9a3838dee',
  '../../packages/protocol/src/session-runtime-binding.ts':
    '8cef7a7a2dcab070d320cf20fd3f98c03dfe71a1570dbd16d8fedd7f9a9d7872',
  '../../packages/protocol/src/types.ts':
    '70f1e9398533294c544475e0d7e5da9eac7e19b097991d58ee749616b50406ca',
  '../repository-workspace-runtime.ts':
    '13db6d8d468d3e5ff4a9c8feaa06e5abbbb040196e8cf5b94b145297a5393a99',
  '../repository-workspace-router.ts':
    'a9e5e5e60382d16fd7bf8f3c4f3dec6c19d5617493833221cd6c524952f5535e',
  '../trusted-native-operation.ts':
    '0e8afb3b0968881d542850c68b5bc3cb362becffb47e354eccf8375e52ff0038',
  '../repository-chat-startup.ts':
    'da5476aa7e43badb1809a8f52d958d5338ec921c6ab96531978f750fecf4428f',
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    'efecd458bf61fecd8198ecd330e0227e2c600ab21d6d2890cd2bac254e22b75f',
  '../openshell-runtime.ts': 'fe3659a89af1b8341fb7beefcc6dd9bb253ccb95011a651f5fa92c3baa5f1b8f',
  '../codex-chat-session.ts': '5df5c2efd4db3b530783fecee95a132cd9169587687a4fe2da955916050f6a30',
  '../connections-runtime.ts': 'dbe641704a1d761d73740260fb28057054fdb34a64513fa77292d2fdb1954a84',
  'capabilities/operation-store.ts':
    '1a235f11d5578880e6dfa7ecf5779e2a011e24430774fc17429d7d22359b93f2',
  'capabilities/service.ts': '848e0998848d68e80ec53731b248a286f77f761905082092821f3ec9047ba36a',
  '../github-seeded-source.ts': 'df6cd2643ac24cb5d85e136c3f82c400e8f50456a69993396e25808455613c92',
  '../github-seed-baselines.ts': 'bb64d20a4a422de8e0c88979ee9dc8101d51fc2c63d8660eb5d991d08d496d2e',
  '../github-seeded-publication.ts':
    '2988fc88db971503bb8f857d0c86cf6134b6ab185cc72529b742c0e1544dd883',
  '../github-publication-operator-router.ts':
    '43a7f7edf9a9bb894be6843c6c3204a308227daeb495aef0f56ff707dace0a7b',
  '../../packages/client/src/protocol-parser.ts':
    '7c667e5be23d1be6274e51ae1f65c3cdaf3bce17849ce468594b2334c674bd98',
  '../../packages/client/src/slices/messages.ts':
    '3bb4b1c704e9426e2a335168ed4be62a4131e76a1b44dc1b4473e2d6ac6477b4',
  '../../packages/harness/src/providers/responses-session.ts':
    'a869b18f9f41527146a213755faa809176d6146f7178c09ecbd0af45e7a7be0f',
  '../../packages/harness/src/providers/session-types.ts':
    '91a52eb6546d2346b5e4c70cb4b164bfcd15b14eaf5682fd2e53af30e91b27ce',
  '../../packages/protocol/src/agent-context-pack.ts':
    '6964f27523d93a64c153f2d3a56650298a2063521abdafffa0c19c3dba839de5',
  '../../packages/protocol/src/index.ts':
    '9b3cd9485f3b284c28ddba8516906db018668a30d6a4703de79a4a0f81387a17',
  '../agent-context-authority.ts':
    '68b721db46cf6ba99de042cdf32be345bfc78c7ae27c2e31ee2b0b52a20ac266',
  '../agent-context-delivery.ts':
    'ccb083988e7c0563d9080a8553d9903abc1cf5b1d669b4583c215508faaee46a',
  '../agent-context-pack-compiler.ts':
    '2d4bc90077def1e87fd267ee9576cbf3b2835a00ec07b971f5f94b71bb7147a7',
  '../codex-conversation.ts': '91041d717070e1de6dba3139a6fd7731d3f93728405967205470b0bcd1ba139a',
  '../context-pack-composition.ts':
    'cae630948dd56814bda2601f3df7469712074899a53b3ff9017b08dce32638c0',
  '../context-pack-router.ts': 'ae314ca49f783d26ed8c419f69683960bc35443923009332fe4a1f9efa2e12d6',
  '../context-pack-runtime.ts': 'b88bf80b58cdb8bf95dfd950626f75d6e055d2ee5ffb3ac3637e90f85e7bafd8',
  '../context-pack-store.ts': '7e7fce4a09496f735b3ffc9da5aaf9c841a544d1d52513203f2ccdd30e2f837f',
  '../gemini-session.ts': 'feba970944dad01df6e5fd2865e3c1373ef6121bc3dde5835bbbaf4fcd264c2d',
  '../knowledge-library-runtime.ts':
    'e0ad96249c276bf5b640197adda676f14121be592abd88f99d5002fc37838c93',
  '../knowledge-library-source.ts':
    'b0192e3ff56deafaff5b506eb55c6c2325c712e825814de6d355b0fe1bbc3087',
  '../native-responses-runner.ts':
    '30cca6fb574a8de890057e66d139a7423e8c79bfeb8dd24363f817e94c597159',
  '../responses-chat-session.ts':
    '537f7cc6e442b2adc21913f326b81f101aa1ad6ddf8c0555f80c9163aaf071bb',
  '../symposium-agent-context.ts':
    'f644a5c5b731fbadefb98d965fcd2e061b19b2b48517668c62385f770124c36a',
  '../symposium-claude-native.ts':
    '901a5ad5c65e70e56973cb79509df4f637182f1428dd8f103df0400c5b2e4880',
  '../symposium-codex-native.ts':
    '46f9b155921092db21ab181b113404d1c593be5a02744d41fbb273857dae2ddf',
  '../symposium-host-grants.ts': 'c79ba3b163ef3f58030ffae396c19b7fa1bbc87788842bbddff6c569f01791ac',
  '../symposium-openshell-seat-executor.ts':
    '95c7f179a0e9e7675aef2110d433542db5217ddf308e52fb19e381cfcf628843',
  '../symposium-orchestrator.ts':
    '3a695f4f38a4828c935342930f01cd1237f88233fc2a641e6917991f1bc85d6f',
  '../symposium-seat-prompt.ts': '1f29774555808c5db22e0458f9767c2b498e99430dbd13da6ab94e607291bf4f',
  '../symposium-session-runtime.ts':
    '8ba172ac854b12b6ddebb8a7685950b3412ba455151fedaee4b8004e028dba56',
  '../telos-artifact-tools.ts': '560e27e41df29aa0b5e8a859731bc956b165e6309f9a0974c16da9ee2c2525e5',
  '../../scripts/agent-workspace-context.mjs':
    '61ee6c960962ec630f75eeedf160f13d31fbb65338639a5305579d29166bd57d',
  '../../docs/spikes/openshell-codex/compile-agent-context.mjs':
    '75cc1a653dbb7d4c20ffbeab8fafcf20b19110ff64110a548d30c65305da20be',
  '../../scripts/attest-knowledge-runtime.py':
    '5737ec8e7fc19a17b6ef5a35c1898e834d2a5d2d2a9f7593b607eaaf1971cfeb',
  '../agent-context-sandbox.ts': '8b61edc17ccc94bc95eae3796e68a0beb9540534e3bfbb348a04154c41995416',
  '../codex-conversation-store.ts':
    'c36089ad3386e3a716c9c059428fa0ec14d66385d686682badc243087670d5ed',
});
