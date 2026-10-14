import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.9';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.118';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../../packages/harness/src/index.ts':
    '2741b93d5b35a7542d87757caf6ea9e359d019e74be0dd506188df1a98dffe33',
  '../../packages/harness/src/session-transport.ts':
    '7aaab4c6a3fb5f362b000e7127a8876fb385928d6786145f974ea8ecd4ce283f',
  '../../frontend/src/components/SymposiumConversation.tsx':
    '7d8cdb78c85f27d4783d9c746e918063a3e27c31b2a92bcb15bae14363f94cd7',
  '../../frontend/src/components/SymposiumReviewPanel.tsx':
    '32be2e13877a0db2e2d8531718b9410138471c01cebc963592df3ed69cdf710a',
  '../owned-local-codex-control.ts':
    '5691cd514b8dc92af077dad4a4b6bca23a65fbec4f1cb67ebf6748af67e631d1',
  '../permissions.ts': 'f4c54aaa6d5d118ad08b7dcedb2e566ce12d2853c370bbeea89a7b50079a9bec',
  '../symposium-director-configuration.ts':
    '2fb41b14d1bf19af75f4b6a3dde81e65ad58e4aeab773612f8819b7d6b70c3ca',
  '../symposium-director-route-composition.ts':
    '6978b9c8ebbaaf7ae50a7086e096e94542654c40f2005d944651426226b9dabe',
  '../symposium-artifact-route-composition.ts':
    '8d9e87e2a2873f0dc841429a5b9a43b93aa194237e4f9594b572e87bff27142b',
  '../../frontend/src/styles/workspace-chat.css':
    '1d631fb2ea64f7afb75a8b4007023f9b256deb9ddd9ee105cdbf9fffffdde1f2',
  // Explicit Local draft selection, exact-request delivery and bound conversation controls.
  '../../frontend/src/client-store.ts':
    '74b4fb663607649429a29639ab1a7c5ad8f5a35d5564e1e475e965f13121d974',
  '../../frontend/src/components/AccountModelPicker.tsx':
    '543e3a4225fd2c58f4a38594cbbbef6ddcfdfaf62f9158caeea26e06af2a1dad',
  '../../frontend/src/components/ChatAgentProfilePicker.tsx':
    '084973bfa05c86b94cebb4c28b056fb19d91493bcd912070b369bf1a8f42cdb7',
  '../../frontend/src/components/ChatExecutionPicker.tsx':
    '03b66355a974aff5e7a8cd9fb946905f5dca0eddf796c390a13fd5299cbe5761',
  '../../frontend/src/components/ChatInput.tsx':
    'd95a91bbcfb8c581cc711bd940fb05c770f4dde42a33c15df721a0cd4b73f47f',
  '../../frontend/src/components/ComposerTools.tsx':
    '4da4ec4fd9f95a6b12a9b79a66f9fedc2f8c00e076459097e395121ca9a94864',
  '../../frontend/src/components/ContextPanel.tsx':
    'e64b65ff9dbb4e5d7e686f189f92c9105b18a8b8edf5433de772515c1d374107',
  '../../frontend/src/components/ResponsiveChatView.tsx':
    '441c27dd5d112b4d496a67460eab8073764244f2039dbf03c1392549e2302d6b',
  '../../frontend/src/components/SessionTray.tsx':
    '03fb5961c34c45dbff98fa06083cf8c6693bcdf95cdb3dea6755c47178a5ea01',
  '../../frontend/src/components/WorkspaceControls.tsx':
    '541fe9e1f01a5ea95f8ede9554a3d228a8bab30240fc483039e98bad8e076543',
  '../../frontend/src/hooks/ChatRuntimeDraftProvider.tsx':
    'fcebbeefa5ff14bd074515519a0c4e1d6774ecd7177921ca2264328239cc9720',
  '../../frontend/src/hooks/chat-runtime-draft-context.ts':
    '4c009cd0b30ef5c507c47310a535c5f94be85f553d6224eac04db37383db73d7',
  '../../frontend/src/hooks/useExplicitLocalChat.ts':
    '3e5d06794a1c3248e84999f9c7f6e9e688404063b45f8a81e0c8f1188ce3e2fa',
  '../../frontend/src/hooks/useNewChatDraft.ts':
    '63427b971465eab55442c1f38cf99e9cf546cb0853ec552a45fc1191758150ae',
  '../../frontend/src/lib/chat-drafts.ts':
    'f3d7cecb537ae727b7a5549274f7b9b549ee2b8b1e9ac952585ea0943aea9f4e',
  '../../frontend/src/lib/chat-runtime-selection.ts':
    '066bbedc41fa67da78010dbc3095e78870d876d3ff29d820675352001a4b9d7f',
  '../../frontend/src/lib/explicit-local-chat.ts':
    '198444bcd8fe43e70e06165936d483cd25107e1981fbacbd024855aeb75f6250',
  '../../frontend/src/lib/reviewed-outbox-storage.ts':
    'dba8f9db6e85204da9bea2380e10b1bc0e1a00fe15ac598bcf8e6cd685a66b22',
  '../../frontend/src/pages/ChatView.tsx':
    'ed41a001473b37126568ef45a382df8575d6d2913e407bfee319b8959394cd80',
  '../../frontend/src/pages/DesktopChatView.tsx':
    'aa4c96c9ba5549539954e5e7a57de111c97efb1b82eb152769cf25c15797c114',
  '../../frontend/src/types/workspace.ts':
    'c54ac596082365496ebf53ca12ce1602b792acfd09092a216285aa69dd38c162',
  '../../packages/client/src/send-outbox.ts':
    '1907f288a670bb60003badb9ff439b8be2dbca9cae007ef80d7f29989ea6f838',

  // Explicit authenticated Local entry, immutable request and shared startup ownership.
  '../../packages/protocol/src/local-codex-first-command.ts':
    '9f3f6cc54fe2a0972949518e228fa008fdd4bb61b89c0706e0204dc776005265',
  '../ordinary-local-codex-entry.ts':
    '91e83a9e4219f76157198b025644637a20dfd78e068d9e6df21d34f2b2327019',
  '../ordinary-local-codex-metadata.ts':
    '95eeb702ef71016448c62d73649cdfa43f5265839509347775755e70cf608fa2',
  '../ordinary-repository-startup.ts':
    '34b441c08703c9239c0f247aea72fc8a759181780006899056cda7e8f51cf608',

  '../session-profile-tools.ts': '2eb02dd87c257f53fa98ea63a998087cf5baca51e77cfea8a935c1900d05da1a',
  '../symposium-profile-proposals.ts':
    'e4865b6e0b3056f7eb59eddbf49517db2cef499de34bca8a7990fbfc48b49c4f',
  '../symposium-profile-tool.ts':
    '62f0b42ba7563982c7c88607e557eda7983d09be9a69baee7da45fc822eb02ac',
  '../symposium-profile-proposal-routes.ts':
    'd47f42be82703af6fadcb081f3d15ab2e992d189418b578bc0c01f2bb2385c5c',
  '../../packages/protocol/src/profile-builder.ts':
    '045cef738778044314a2bea1b769f31f7ac5bf68d001782307bad56c11e548cc',
  '../../packages/protocol/src/context-injection.ts':
    'f374381a452c3a5354d9b4e84b21ad3d6d40d10879e43124dec30f40118f60bb',
  '../../packages/protocol/src/ordinary-local-admission.ts':
    'e0e6cec3020ea0d975a31a948e7b0931f86b3f842266360364211a892866bb4e',
  '../send-command.ts': '18bc97eb0e66226fd777c77d58597293872c3e6378b071a91c6514511ffe9750',
  '../ordinary-local-codex-admission.ts':
    '7ccca3a7139c33e7d7862e2851799cb361506cfc36d6e9fdf83b1321d47d74d6',
  '../ordinary-local-codex-capabilities.ts':
    'bea6fe896ae2956aca4d8b7ec62077ef2d35d0753a94ca78e888a721a26815ea',
  // Owned local command authority and the existing helpers in its code closure.
  '../ordinary-local-codex-host-runtime.ts':
    '5b152f654f029ad43dc1ded3808ea9fe2765b02c753b3a4a414867cbb37e078a',
  '../ordinary-local-codex-selection-owner.ts':
    '9f06bdc1412de620be1988f6af4b5bafd0c5407252d755486ff1d03b0917a3ce',
  '../ordinary-local-codex-owned-runtime.ts':
    'b4e9409632414361f3c21ca50b1387118774b7bf4e3512c8191c78a60628dedc',
  '../frozen-host-codex-login.ts':
    'eba897dd3a1d86f6e2567d737980fb74a963a610aade76862222542bd2f81805',
  '../frozen-host-codex-executable.ts':
    '4df86cc1b77d7b4186f9c285bc77fbe1127d16142501d78cf45ea77d628be96f',
  '../frozen-host-codex-bootstrap.ts':
    '81a47639a36d390b3daea6387138d7915408ed60f80df286b27ca9d60b0d48b0',
  '../owned-codex-lifecycle-bridge.ts':
    '784da43bccb37c0ec044ddddfebf547c6d72f94737e32b35378ac761376d0f1c',
  '../owned-local-codex-chat-admission.ts':
    'e2ed02266597cb953c0bfc744d26082fe4fff68b647ade394fc4f9f539c4b7b3',
  '../codex-account.ts': 'dc2ac5efec915495b6af3c7a3001ea4856427ca2d185648a864d2ceeb6593e71',
  '../codex-runtime-policy.ts': '0ea70ad304a3e1a8f198930674064fad5048d3626751da41f33be1daa96081cf',
  '../model-catalog.ts': 'e6922550fed2f7d6d3330299dfe83726d97d126e79c4a3abdb5e3334020ce90a',
  '../bounded-file-read.ts': '8332b3e5908ebe1464eeb7c99a8963bc402ae1f2d89a979a7495f53d54914070',
  '../session-permission-revision.ts':
    'cf71bb38e2008352cbccfd22aae88f747625a3533c26aad22537d9509c11a26a',
  '../auth.ts': 'd65384a12b4a55f2df4b88fd237a7bd99e73e21d7d495d598106d02c393e9516',
  '../native-file-operation.ts': '0bdd92a554e86f5adc56f3607ba053eca7de22281343f97a9e6cc5e6c046f1cc',
  '../sandboxed-command.ts': 'c11012fbceda32ab6104b791ec598ba9b6c82a2d21d8571f393c3d61f87bdf67',
  // Shared approval scopes, transport custody and provider environment delivery.
  '../../packages/client/src/sse-connection.ts':
    'a8e6f572e9de9ac4fef778b039d5fa1af44ebc2a5268944a7833574103e7bc3c',
  '../../packages/client/src/store.ts':
    '37c17263d92130aaa54ffc6e2b05d99dea5b2a02190449284042e2c35640490a',
  '../../packages/harness/src/permission-handler.ts':
    '20d09ccadeb668c91008713b45aaffd5762d34c0a6dc1651b3e234732743a7fa',
  '../../packages/harness/src/permissions.ts':
    'e00992d7d86e56d950964a9f6a801f541a425df818a5ff3b6405e2778a1ca0df',
  '../../packages/protocol/src/session-approval-scope.ts':
    'dae13365f4eb821d9563e5a3da65c60135f2081e319a34c7dad3ef27b02ea733',
  '../codex-app-server-client.ts':
    'b6e4f8b618c7364cba4d1f8a98f1406a97e64d7b79a6b8c77d389aee687b5c7b',
  '../codex-mcp-tools.ts': '375851fb458c8d930a52a1d3bc32460b2a6174a64a4516af4f68084b1ba484de',
  '../codex-runtime-diagnostics.ts':
    '80730e66ff8aa543acfb4ce035c7cf2fbe936172498d3b8ed0d868143bee4513',
  'capabilities/approval.ts': '25c074b3091e67b0c3faba822e8e2c00ff32a34416fe0b37cb4f202d040d0320',
  'capabilities/types.ts': '2d87b1836d4040bb8a887c17d89cc3ccfab213016e6d276cbb3cdc084a0b9a89',
  '../notification-center.ts': '7846b7a675681c88a9ad291ebdbb3805a0ef4380bf77b8af4bd87026f21c7bd9',
  '../notification-routes.ts': 'e43523f346d383f9f22dcfe3687840314c33a5fbbdd165c368eff22f89bfb1a4',
  '../symposium-custodian-publication.ts':
    '475e37cf3b7187bcfc022054c183aed4fe6239c2d4736108f40a5abef3a4bc2a',
  '../symposium-publication-approval.ts':
    'dcb4522017e75ac7308dcf405e187cac59905dde94c8b0a5da771a625d051152',
  '../symposium-publication-routes.ts':
    '3f65373bc07c77441dbbd367388b82aefed9186eb0d003e54518cbe762131f80',
  '../symposium-sealed-publication-authority.ts':
    'e71d039c70f52a061ecb2bb6779aa4693288965a814d99d75dab0c224f18c8ff',
  '../transport-auth-ownership.ts':
    '945d7eb8ffc97d53d16dc280698ad4dfacae8cb063cc974c269235058b5f7d14',
  '../url-access-tool.ts': '5ffa93b5a0d2160d19e144248b679cfea7b120cfe27fbe7cdf6029392eafbb59',
  '../web-access-tool.ts': 'b1444e725ed36a8f9a1d12dc812df56a34e1fd84f86aa4559f521ac0b9c58668',
  '../index.ts': '9f2be170cd902ed5a0fa1c85cb865b06fbaac814403aeec1c0b7f370f03bf5a3',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',

  '../chat-rest-handler.ts': '3bdb3036f560d7d04191597daa8c0df5d1767e87e0d564c1996b0572ac6b997a',
  // Contributor live-query capture and exact output ownership share runtime admission.
  '../query-loop.ts': '618cdfaada03c8c812d2849a7c589079d800e7fda33346298eaab85b145fd1c6',
  '../account-profiles.ts': '7179fccabee7418e7d6c791656343c5a6b048c595335521f0fa629ce71348b3f',
  '../ordinary-turn-lifecycle.ts':
    'a138e83ba1a2ec8ceaef967858fb926d5de83658d21f555f32c98174afd4064b',
  '../ordinary-contributor-guidance.ts':
    '73384ce804421b34005e145073e7c94f7a07819bd77daed5a4c32163fa942e2c',
  '../ordinary-contributor-execution.ts':
    '64c85d35d19b57b4fee7ae3dc8ff6441a666efbfa36237b0a4b9f6ca63b613a9',
  '../symposium-dispatch-boundary.ts':
    'fdccd76d0537d9edf665eddbbf0d2fdb32dddbbe5bf423498e21ff04606e9dc8',
  '../symposium-seat-runtime.ts':
    'b5584fc1387894ecb9658bca82b07ec38460577770dda51f7b8dadf13d7114a4',
  '../symposium-host-grants.ts': 'c79ba3b163ef3f58030ffae396c19b7fa1bbc87788842bbddff6c569f01791ac',
  '../symposium-shared-execution.ts':
    'b884e6783d170bde0570d9ab645b13a69a3ab531a77ad12534bfb2160a609551',
  '../symposium-ordinary-turn.ts':
    'b50f0e3c04dacbde20133e42f2699bb50fd9661bc96395fe6fe5c4162bcf991b',
  '../output-contributors.ts': '74d6d4fee3865a460337ed1bdffed39c570e91824b5c201cf87c30c87f692695',
  '../output-contributor-routes.ts':
    '73b7904feca4cded6349e1efde0bffc603df47bd16b3435d02f14ce21b3f21fe',
  '../session-output-references.ts':
    'f3cc6ec16ec1c2dc907566658c3f12b1776ee35f1bde662a77e97b9a08946841',
  '../session-output-routes.ts': '2e08e938b4914797006231d1044b2c6c28693aa7fe1813a37d6ba1c9697649b2',
  '../../packages/protocol/src/session-output-reference.ts':
    'c103af10de4adc81cdc474b3e69ef2b3de5e447d4dcf15da4fc1894c422b913b',
  '../../packages/protocol/src/session-output-reference-store.ts':
    '1b54dd00d94e99974b536a68cfc0b5cdc841e2f6453ba7bc58b5c4b98830c7ff',
  '../chat.ts': 'ff395518a7e44a8fbd4bbba6b0e8822c52bb8cada6336b9c16a09a5ab5444237',
  // Contributor execution lifetime is independent of viewer detach/expiry.
  '../../packages/harness/src/session-registry.ts':
    'bccd81b31e6a1444a2b53c67f8ef11524c08bb4f4d95fa3f76c6b79ab4e443f8',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    'f254cadb334bc75dbb19104fdb7ed2b3e46bf2856b81d29300fd4f45db02674e',
  // Read-only session observation is part of the operator route composition.
  '../session-access.ts': 'e70130c57879d3b22fab78473d90c8d2e787b7a499194c166e7e912fc5cf2767',
  // Request authority and physical review composition share runtime admission.
  '../app.ts': 'ec59b372cf6bc7653f1fa46f874936d0e553daf240bc225c5098df843e7decdc',
  '../auth-check-tracing.ts': '067dc344d8ee76ffe39739a99076f614711ca3d11f96682c842c596a7bbd112e',
  '../telemetry-relay.ts': '302bf6cec2b988ae71a123a5dd04d0f2266a82c3ee51873ec64d8be452c25427',
  '../symposium-review-route-composition.ts':
    'bc2cb2a85517a1f16279fd87757a97b9bb46a16d9efc5f15b52bf41a6f14cae3',
  '../symposium-review-host-contract.ts':
    'bd41408c8dfb9fe4a239fca2e35cf8366bc379e63c4a310d3593cf709a1920d3',
  '../symposium-production-review-composition.ts':
    '5d0e4d78e45cc6d9b3c601cc1f5587c469432bb3ec9edc0c70fb34153dedfc5e',
  '../ws-handler-v2.ts': '6478161268a52db947b09c52666724447e937ae85b98423d21cb849ee42d9704',
  '../briefings.ts': '277b26171abc42266a3b621ff7ab10306792764cb55bbc635e41c4ba20e98d49',
  '../home-router.ts': '744708f3503d3ef46114998ce9bb6a68b3068a3c7d57e0c264298cdb69aac982',
  '../notification-store.ts': 'd73b922e8e04b1e6415d1c1388bcf75edb4b65c913d3636b9a63e16583bc035b',
  '../unified-inbox.ts': '4ff43026cf624b1e260c522f5fd293533559d3419629ccb847a425e6d19102f7',
  '../inbox.ts': '9af9b9103a285be2a344fa8b6530ed944226146574fc47ce03db3071a5f6a82e',
  '../codex-queue-routes.ts': 'bb10b4351669781484388088c5dedf5671742e01a9139d8bbe64d255a96027eb',
  '../agent-context-compiler.ts':
    '3125d60c7035cb62d3e6d9291f126c9906e5b0b8398524dc750e97c6d7eaa7b2',
  '../../packages/protocol/src/agent-context-recipe.ts':
    '05ca755108920256b95d1bf051b9937bfdd3fb0e745c64d3ff033a82d89c6289',
  '../../scripts/agent-workspace-context.mjs':
    'b49dbf16dacccce450192f19d12d3ec48c4fd4d2212602bb70632196d84d362f',
  '../../docs/spikes/openshell-codex/compile-agent-context.mjs':
    '75cc1a653dbb7d4c20ffbeab8fafcf20b19110ff64110a548d30c65305da20be',
  '../../scripts/attest-knowledge-runtime.py':
    '5737ec8e7fc19a17b6ef5a35c1898e834d2a5d2d2a9f7593b607eaaf1971cfeb',
  '../agent-context-sandbox.ts': '8b61edc17ccc94bc95eae3796e68a0beb9540534e3bfbb348a04154c41995416',
  '../codex-conversation.ts': 'ed8c9d13e9ded7e0ff7237a57c0e94f52527745fac562e7217bbfa57c6703060',
  '../codex-conversation-store.ts':
    'a28a891d7e15e599f67b78e9db30fb6b73c24b838b39bd7a86f44d078e6e5d0e',
  // Library profile identity, operator ownership and admission are reviewed runtime inputs.
  '../symposium-director-routes.ts':
    '71fa6b5d798815b452b26f7df5c58733abb793222bfa21ec71926b8bba2d8e74',
  '../agent-library-binding.ts': 'c674ceed550400f9dbe04c34544f9739520ebb8d222887489d988fc38493bb53',
  '../agent-library-transport.ts':
    '1ddf221a25d11c991b669007ef900140056c321f8bb67d12218940a7dd4c4ec2',
  '../agent-library-store.ts': 'fac60510d3a4b45aa34777daf885142e067538726104c749f4ebe533861472c7',
  '../agent-library-router.ts': '0b34aeca9c7894a3dd4cfa9ad9b930c20e5b54c30010b18c0553dd7dd1b6cc61',
  '../agent-library-runtime.ts': 'cc3be2fc2f61053d4430960a2328d41146463fdca701840a92ab65a89b29922d',
  '../agent-library-prompt.ts': '3be39c6cd2fb12c744c5f53e45b8c8b306398146edfcb2af479d4fa1c9159c28',
  '../symposium-profile-portability.ts':
    'aadefe0eab442dc27ce68b86654291299dc6664a185b903af44756f79ff26680',
  '../symposium-profiles.ts': '4138fce2cc44220fa90b3ef65b207b89c06a5f02cd24750a748f79d84d297c95',
  '../symposium-custodian-protocol.ts':
    '96750498e49418aee2c8cb1413d639f17d060e34f01242d42f72890562d516c1',
  '../symposium-custodian-proxy.ts':
    '59f78245236ef2c05f5f2e9c610629c1f513fedb32b4dae753c6275bd434b3a9',
  '../../packages/protocol/src/agent-library.ts':
    'c9c5fadf380fc72edc81ec7b762d1f69620d06dff5ca40a949568ee61a2a068c',
  '../../packages/protocol/src/symposium.ts':
    '19e2192db110e0fdc3c4c47a2c8424c1614dab48dcbd92161ff2730896cd2c79',
  '../repository-chat-tools.ts': '74e686017b043f61e063258aadec9387f2141e5f5a94238bfdcd6780b3006a77',
  '../repository-task-copy.ts': 'cd15f77cfa45883556d10536296a28f7451d2259a5a3eb2a9aeb807d24c54d6d',
  '../credential-connection-schema.ts':
    '3489ff131cd0bc28de23d85e1ed7cd4749fcb12f062bdc76407bedc0efe28f47',
  '../credential-verification-error.ts':
    '1adcaa9d47b413796b94f6aeb44bf152e2daa27ec30759d1ffd9ce5e1240ebea',
  '../credential-setup.ts': '8dfd54d1b4cb4408d52c9ca09f5cc220ba69adf6dc6181bc7de6803fee38f69c',
  '../connection-guide.ts': 'd0fed6560d2c2b4d99c74af278b3490ac66b3cb5b161bdeb686c57e99208c0dc',
  '../credential-setup-continuation.ts':
    '6cb81428bb08fa2cf6b79e762573e34dc87f281cfc5d0be70b5316ce66fdd493',
  '../credential-setup-application.ts':
    '387ae34d23260d5e27a9585860210b157aa0ad23543eb13e70fc46496c5dbfb7',

  '../github-repository-connections.ts':
    '3917a36a0cc8b3bb73f1f4fa66e93e17be3b0ace58eff2bb3e0470bd67b7c11e',
  '../credential-websocket.ts': '87a41d7c329dccb6616726feed14a5fb25c8aefe94556c767f42618b8d995810',
  // Keychain HTTP/WebSocket credential custody and exact-session approval handlers.
  '../home-assistant-dashboard.ts':
    '1053d482935af066472aedd48365af2b71cb7cf55e30ee88cc9fcf89b96e1d62',
  '../credential-connections.ts':
    'bc7316e8c8a5d9807e7afb9ae174360fccd790d1931c87cdc8edfb1dbdb8b173',
  '../credential-connections-router.ts':
    '6d7b779ff5ba148b6aea43483f4003da0d9ed4908e551a273de5906140c7b96b',
  '../credential-connection-tools.ts':
    '79a1dced902c614c857b14a353af3a72e95eb7b9a727b7f1fd88444aadf90227',
  '../credential-connections-runtime.ts':
    '89a1cdf4bd50c73a0aecfb966303fb37e0f524da9fb977478602c9c198a51b4d',
  '../credential-http.ts': 'de01cafbe00fbc4a470483afae3c2fafa8ba81c295187f9b22b5188c71cdd627',
  '../credential-redaction.ts': '817dda948c419deb064bc4c5298e034e5a0343972b4bf724fb6aaa869cf34403',
  '../credential-sdk-tools.ts': 'de3a110d32b4a831b25c07918b9f35409cbb4ccf75ec0d5dd0667b55e3d55685',
  '../session-credential-tools.ts':
    'd247fa81824cf37e25c401fc76c92a50e185db6993f1b6e73257900a17240a3e',
  'policy-compiler.ts': '59579f9eb69a3129dd2d8e1676fa46bd21da45c07f58752183416c82c0986014',
  'registry.ts': 'd93c4b41cff1d0519dbdcbb466a035cc256b7bcc63d2e1440e781cda64833561',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  // The capability binding is not trusted merely because its manifest is
  // reviewed: both the production executor and its OpenShell/Git transport
  // must match this revision before the registry can advertise the action.
  'capabilities/github-publish-pr.ts':
    '223e79998e68e1bebead17a7efe29c6a8f32fc5dbadb1a335a54bdae2aeb5d7e',
  'capabilities/github-publish-pr-transport.ts':
    '434d2c56164bc372b9168fba26acb806f509a759eb2f8c24ba8eaff5c8c9f5f8',
  '../github-host-source.ts': '2720dd0fedf081780ebd64a485164ec5abc6dee7920de925d35e3e6aa647e084',
  '../github-publishing-tool.ts':
    '82e8d7c216faab711a5c3dd55625a441cfce22a2d1801cb050b32d55df23ef4f',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  // Secret custody and its browser/admission boundaries share the runtime review contract.
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
  // Repository acquisition and source claims share the ordinary runtime admission review.
  '../git-branch.ts': '6dd4fef0069e65d78fc94d047777442e4ef073596555581da536e1e39a5d3877',
  '../github-repository-source.ts':
    'b9a6ef89472b001cb8cd8f8bc04c3b31d514980d9a5154cd6ad48c5b30d42c09',
  '../worktree.ts': 'e3fd6d93d33cb5403786c5a7da16dd229d8ba03ad06e8c3abaf6309c64adb34a',
  '../repository-task-checkout.ts':
    '32fd232781b0ba9573fa0e6a511a78ede54a8c33a80dee30f52d06283b4beab5',
  // Operator runtime enrollment, private metadata and write-authority admission.
  '../workspace-runtime-private-paths.ts':
    '5839c75aa2e5d325218af40547c28395ec92a56205fd50a023497330aa44811c',
  '../codex-private-path.ts': 'a42946b67c811a916df26adf760ec8b7b8551123fa724edf8fb4a5ff6f866b43',
  '../workspace-runtime-client.ts':
    'eb377ad70361797cb34de00c1974952b76cd81041da7668631b138cf5d44473f',
  '../credential-sdk-boundary.ts':
    'd577cd3f4addce8a09ec6e49272196143f28d6e88abf7a4405336542acbf2bfb',
  '../sandboxed-command-worker.ts':
    'f2cffea266ca292c2ba690725820e2c23d4a90fc3ed61619540a960bbfe72f23',
  '../protected-sdk-command.ts': 'e7c59a2ebfd3fde4b0c7c8cdf7f69f9d231e2e5f1819a61e0514cd707bc6c32f',
  '../native-hooks.ts': '5708a6e09129765ab760a6c078fb2571dc73dc1125c9be31b43f1865fe5e461b',
  '../hook-bridge.ts': '8885c2b27079799d33958a17942bb7d8953d01540bf7cd4b3ade537ee39c2d12',
  '../native-tool-executor.ts': 'd3070a6225870bcd6bd2e5cb1eff8ddbf899a6ba0f84aa00fd2820ee9f77c9f1',
  '../repository-workspaces.ts': '2211f29498e2ba89164dae8d5799e06714b000a963dadb1e3c0f63ef0d741187',
  '../../packages/protocol/src/session-metadata-store.ts':
    '0b8cd73207cca8d62405b1de64dabb73da47b4d19b6a83801259b24148e9db9f',
  '../../packages/protocol/src/event-store.ts':
    'b5ef6697a88d9c0be1fc6a5a774e36e4c3fa52b00a8778e122c2b164feb836fc',
  '../../packages/protocol/src/session-lifecycle-store.ts':
    '2a219b360a5fbe72b0a550c714bf76a15c6f5969cbbe4251671050257b98e267',
  '../../packages/protocol/src/conversation-replay-store.ts':
    '60ca279c37909d56d842535093f8d8186057a668a1b03a8e53c41f92061da32a',
  '../../packages/protocol/src/execution-ledger.ts':
    'f30d210be1d37f4c61ff47edb1fb3c8dea1dc6fd8d3ea02b6e01310e8d44ffc4',
  '../../packages/protocol/src/session-runtime-binding.ts':
    '074c03124322359a02795c7865a718205f80f8aa9fc6b4e0b5a8f43746d6ca4d',
  '../../packages/protocol/src/types.ts':
    'a2a93b0fca7ba3af11c5f4fc89d4626f10428310b65a168347d4b519b839fdba',
  '../repository-workspace-runtime.ts':
    'd0d9f288fd29f618e4c7429b93950bb391c9fd65c76affc36bc8a11b90d730cc',
  '../repository-workspace-router.ts':
    'a9e5e5e60382d16fd7bf8f3c4f3dec6c19d5617493833221cd6c524952f5535e',
  '../trusted-native-operation.ts':
    '32dae1fb013f452d341c7d6a4555ef4ac8ae64192cabcfa798f6adaaa29e473b',
  '../repository-chat-startup.ts':
    'da5476aa7e43badb1809a8f52d958d5338ec921c6ab96531978f750fecf4428f',
  // Admission shares compiled connection authority with gateway provisioning.
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    '9733d55cd1cb15dcf68dd844fd85861bf4fece6f3d46e1926ec9c416dd59d7f2',
  '../openshell-runtime.ts': 'f0c1015a163442f0bc54fba0e4fd8d1a70e4f7093052aace7d707e78c7b6a5aa',
  '../codex-chat-session.ts': 'f3778d2fc76882180f8aa5454af1f94050b566ad7c6f62f7cb250e27a5b32a6d',
  '../connections-runtime.ts': 'dbe641704a1d761d73740260fb28057054fdb34a64513fa77292d2fdb1954a84',
  'capabilities/operation-store.ts':
    '1a235f11d5578880e6dfa7ecf5779e2a011e24430774fc17429d7d22359b93f2',
  'capabilities/service.ts': '14a1986c8d019599788ee2538ce2e0f991a8af56c0d186977063a523dbae6516',
  '../github-seeded-source.ts': 'df6cd2643ac24cb5d85e136c3f82c400e8f50456a69993396e25808455613c92',
  '../github-seed-baselines.ts': 'bb64d20a4a422de8e0c88979ee9dc8101d51fc2c63d8660eb5d991d08d496d2e',
  '../github-seeded-publication.ts':
    '2988fc88db971503bb8f857d0c86cf6134b6ab185cc72529b742c0e1544dd883',
  '../github-publication-operator-router.ts':
    '43a7f7edf9a9bb894be6843c6c3204a308227daeb495aef0f56ff707dace0a7b',
  '../symposium-subscription-native.ts':
    '64eadac8483f30497939d4c19db4adeb3e6ac189b7e97e8fac855df11ca80975',
  '../codex-approved-search.ts': '49be84f5fbea7fbc2453585393e9e0d2eb0af75ed6a776f1dd5329c9c91240c7',
  '../native-codex-context-admission.ts':
    '91a021e0dba7a2e1d38cfe2a744da603370f562f5d78c25255237d4065eda558',
  '../symposium-host-tool-bridge.ts':
    '93559b7b6a5aeb1e66e633d2038cedd774d1a9efe1e8bbfc20d83c7e13326ba0',
  '../symposium-seat-authorization.ts':
    '26006d392e10e68c695e00039935332c28fb7146feaa057e482afa38c4f1fa21',
  '../../packages/client/src/protocol-parser.ts':
    '1aaac1b2839aaea054157b42bf39effea57f77bf28630367057e30c0f4a43aed',
  '../../packages/client/src/slices/messages.ts':
    '4bed61fceaa9a34613c2c923bbc6e2c74d6dc66ff04d8b897a513d41af66a9e2',
  '../../packages/harness/src/providers/responses-session.ts':
    '8e2db677e8648488c25f50aa74604fd734b694f230ab137436481fb62aacaa74',
  '../../packages/harness/src/providers/session-types.ts':
    '53af4d3c4c3cb3d3e3179ca306689aad6faa03669d9ad62d652e21d18babf8b4',
  '../../packages/protocol/src/agent-context-pack.ts':
    '6964f27523d93a64c153f2d3a56650298a2063521abdafffa0c19c3dba839de5',
  '../../packages/protocol/src/index.ts':
    '8c14b103def67bf9796614eefc03cf861adb7aeace1215ed0b8ee975d1ef20bd',
  '../agent-context-authority.ts':
    '68b721db46cf6ba99de042cdf32be345bfc78c7ae27c2e31ee2b0b52a20ac266',
  '../agent-context-delivery.ts':
    'ccb083988e7c0563d9080a8553d9903abc1cf5b1d669b4583c215508faaee46a',
  '../agent-context-pack-compiler.ts':
    'df2afaef1586ea8f56d8cf71fe94fecafd2bc421a1258c898ac5202061b4cca8',
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
    '89680b91a569095ff275ba0987a819e70ef55a4a20e5b1f53d7211c2b9eb4ed9',
  '../responses-chat-session.ts':
    '49dc1349739ee26ad366f242bca2f1956eb103770002ef124ed5aa39bf65c201',
  // Image payload validation shares native queue admission and dispatch authority.
  '../responses-input.ts': 'b4be57d3535660a31597f07b075070a90b49b2e62239916937e9316e78cc4b05',
  '../symposium-agent-context.ts':
    '5aac047168428af37b9167a9dd4f9eccf91354a76c6bfc3a0907659782e5af2d',
  '../symposium-claude-native.ts':
    '901a5ad5c65e70e56973cb79509df4f637182f1428dd8f103df0400c5b2e4880',
  '../symposium-codex-native.ts':
    '1bb7c2637d825683b178b64f333eebe5a7216dc6f82c6e210b87b4ffe5f8c7fe',
  '../symposium-openshell-seat-executor.ts':
    '74f8428334c14dd0efcf4e8bd12b265ed279e2ba238934f15636c1719aed9f66',
  '../symposium-orchestrator.ts':
    '3a695f4f38a4828c935342930f01cd1237f88233fc2a641e6917991f1bc85d6f',
  '../symposium-seat-prompt.ts': '1f29774555808c5db22e0458f9767c2b498e99430dbd13da6ab94e607291bf4f',
  '../symposium-session-runtime.ts':
    'c60fc54ab05cd6fbcdbf1f549ac59664df9684df31d8a426e1441afce7fec788',
  '../telos-artifact-tools.ts': '560e27e41df29aa0b5e8a859731bc956b165e6309f9a0974c16da9ee2c2525e5',
  '../symposium-agent-context-authorization.ts':
    '497a2c4bbb4ca61892e392b11fe554bb88d5302921eef7305f88e74d03c206cc',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../packages/protocol/src/ordinary-openshell-admission.ts':
    'd55a6266b2d5b4df95b9ab2e92526032de1ea6f080921f5adc4d182fced38f3f',
  '../host-codex-custody.ts': '684485006e92b26780a32b7f76d3bcd5086ab7492bc43508414d278278d4a9a3',
  '../interactive-auth-core.ts': '920d9ad2e146cf4de329d28ecfb13c0b235c2a379abf4472d4d0e37559a2cc29',
  '../openshell-codex-custody.ts':
    '879381e2a91161c01c257888cc6760203e505fc43f84ee9e9d84558ea60f695b',
  '../openshell-lifecycle-controller.ts':
    '28461779f5af5ffe1c1e3fdcb3567eb126888debc7ecc9d42c059d6434dab699',
  '../ordinary-codex-continuation-status.ts':
    '42bc42d123db1572936ea9c3df503f7f550d29e49a9ce2932fa25d6123b5d663',
  '../ordinary-openshell-codex-entry-owner.ts':
    '0bac6e9d3bd1d0919a0f7e9d2dc823a53574f41c80ef72cb1e5da5d81ffe5009',
  '../ordinary-openshell-codex-entry.ts':
    'a327742d6404b4ac3aae135eecedbed04fa13a8cb7302b806d25d4257f69334b',
  '../ordinary-openshell-codex-owned-runtime.ts':
    '178e5e73abfe9f0234929cecb3ff960abc19d5cdc516a9ffde5ce46e8b88ccf2',
  '../ordinary-openshell-codex-route.ts':
    'f0bfd42b4dd663d2577d77ca857fddb9a1ac67d6a894f440b08764b7b33191d2',
  '../owned-openshell-codex-chat-admission.ts':
    'f191340f2ebeffa6e4b243ae7aeb64b919c6ac703239c1737a7e6529a17cb439',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../session-registry.ts': 'd91b89354926d0ec7355e73fcae4f41066008d63097ca00077f37022fc554ccf',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../approved-url-fetch.ts': '86e9a5200a452c3f43ed4578e5553c1595e479ded11359c7a2a8fc2838cad2ad',
  '../owned-codex-queue-control.ts':
    '00c6dbf8ada1f6da8b519600380470a1a42090e125877b79a6149fd7d9667e9c',
  '../public-web-fetch.ts': '805cfe93e5d8511920ec615334354afa23bac14561d6b7aff8c9117f8281c5d7',
  '../ordinary-codex-agent-context.ts':
    'fcf7bc0b5c5942913671ee9c0212b7122d0cdf769ce49806a1047f14158a841c',
  '../ordinary-codex-agent-profile.ts':
    '4348e00569955b6b6ed5b342f56d14def1de1e2a56cbb930232a2384389a580d',
  '../native-responses-store.ts':
    'b51c8eb42773bdc53702b1fd1f57d7e86546e77a9afb85f251abe9da86211890',
  '../ordinary-local-responses-capabilities.ts':
    '22c442f7804e3d80a4482427cb2eace8778825d5876b6167686a96f07f65fead',
  '../ordinary-local-responses-owned-runtime.ts':
    '6d4bba15685033907422257bf30ec68f37d4db8564e3a291878ba42dd58ca859',
  '../ordinary-local-responses-queue.ts':
    '554f9a1352641f367f8a513cd5fde00ce3187465fc03ce2c5f35df807d59ad85',
  '../ordinary-runtime-capability-composition.ts':
    'dc11508e205a7a0853e0d3113550aaa1f97fe47938e6c007a8c0132e0d557667',
  '../../frontend/src/components/ShareButton.tsx':
    '09b59817a6877cb6d28ecd7b3a83169780a5ce39a420c720561cd4106c045f64',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../frontend/src/components/CodexQueueStatus.tsx':
    'd184be19fe19f7b29b2376b767f0f383001ff40b87e76b3d723d0c0431ecf265',
});
