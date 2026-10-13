import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.9';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.78';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../../packages/protocol/src/context-injection.ts':
    'f374381a452c3a5354d9b4e84b21ad3d6d40d10879e43124dec30f40118f60bb',
  '../../packages/protocol/src/ordinary-local-admission.ts':
    '85f66be424edfcbcb5b072b79a7113b491b1f486b7d6a0ba03ad9cbf2d3bdf2e',
  '../send-command.ts': '18bc97eb0e66226fd777c77d58597293872c3e6378b071a91c6514511ffe9750',
  '../ordinary-local-codex-admission.ts':
    'e6415b6b0b9e56620235134655c3715157d7205ea67be025c47bbca2adc30c81',
  '../ordinary-local-codex-capabilities.ts':
    'bea6fe896ae2956aca4d8b7ec62077ef2d35d0753a94ca78e888a721a26815ea',
  // Shared approval scopes, transport custody and provider environment delivery.
  '../../packages/client/src/sse-connection.ts':
    '8b1b03a6acef8c507b2ce1c60842c79ae2d628107a7b880c0c24a168b03a3ef3',
  '../../packages/client/src/store.ts':
    'cfaf577d9ffdc51ba4368b4e5a95f1c504360647426c9391d79dd662ff3188cb',
  '../../packages/harness/src/permission-handler.ts':
    '20d09ccadeb668c91008713b45aaffd5762d34c0a6dc1651b3e234732743a7fa',
  '../../packages/harness/src/permissions.ts':
    'e00992d7d86e56d950964a9f6a801f541a425df818a5ff3b6405e2778a1ca0df',
  '../../packages/protocol/src/session-approval-scope.ts':
    'dae13365f4eb821d9563e5a3da65c60135f2081e319a34c7dad3ef27b02ea733',
  '../codex-app-server-client.ts':
    'f150a60213f8653e3939a52d8d4c396097bb55a5a7b694c0c086d55a47ed2aa9',
  '../codex-mcp-tools.ts': '18eca64a971917e804f0263817a369a725f7d396b6661e636ef20793d75a5c8c',
  '../codex-runtime-diagnostics.ts':
    '80730e66ff8aa543acfb4ce035c7cf2fbe936172498d3b8ed0d868143bee4513',
  'capabilities/approval.ts': '25c074b3091e67b0c3faba822e8e2c00ff32a34416fe0b37cb4f202d040d0320',
  'capabilities/types.ts': '78ccd6205c86f13300d0b42b36159ac23ecb11925f68bc4c042397ae1d459d30',
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
  '../url-access-tool.ts': '4eea0e50346fe1e61acb1668ea33499651ad9a7441bf763a83544ac7a50a510b',
  '../web-access-tool.ts': '3b0d11abd05a3f86a2dead25caf92343ca7a7d9e402480633482bbbfa0be655a',
  '../index.ts': 'e1fc4a9796bcf7d091aed3f5a93dff0e598719c95c8a6fc6edce7b214b450392',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',

  '../chat-rest-handler.ts': '257efb6acabd636c6f4345b7b112270bf993e65be8875b084ea1a205271ec86c',
  // Contributor live-query capture and exact output ownership share runtime admission.
  '../query-loop.ts': '536109be7d7bbdb74f21b521265c789765d967eb871f802388a9e6ec7236ac04',
  '../account-profiles.ts': '0de19ad8f7541f9632c6c553bf9104a80965af84eb0f93b0e4a13a8d9ffcba76',
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
  '../chat.ts': 'b2ebcd7693bc319ac69ad75134f7ecc36b3b93e0d4cdd13263241f9e32d4e582',
  // Contributor execution lifetime is independent of viewer detach/expiry.
  '../../packages/harness/src/session-registry.ts':
    '5ad72e9be9d3289a13511aaa1bb107b527283493e5577e08912ea4fdc4740a81',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    'f254cadb334bc75dbb19104fdb7ed2b3e46bf2856b81d29300fd4f45db02674e',
  // Read-only session observation is part of the operator route composition.
  '../session-access.ts': 'e70130c57879d3b22fab78473d90c8d2e787b7a499194c166e7e912fc5cf2767',
  // Request authority and physical review composition share runtime admission.
  '../app.ts': '2f7b64308de611de20c847341bde83b8e63116d32d48f9858f17a160979d2e39',
  '../auth-check-tracing.ts': '22a3e6c0830cd014e011ed396f323442b37f4b984098d4e51409089d8fa6ffb9',
  '../telemetry-relay.ts': '302bf6cec2b988ae71a123a5dd04d0f2266a82c3ee51873ec64d8be452c25427',
  '../symposium-review-route-composition.ts':
    'bc2cb2a85517a1f16279fd87757a97b9bb46a16d9efc5f15b52bf41a6f14cae3',
  '../symposium-review-host-contract.ts':
    'bd41408c8dfb9fe4a239fca2e35cf8366bc379e63c4a310d3593cf709a1920d3',
  '../symposium-production-review-composition.ts':
    '5d0e4d78e45cc6d9b3c601cc1f5587c469432bb3ec9edc0c70fb34153dedfc5e',
  '../ws-handler-v2.ts': 'bf3c303b78cadcda945ce45532fd1185aff34159e3e73b71b24cc4db26217b73',
  '../briefings.ts': '277b26171abc42266a3b621ff7ab10306792764cb55bbc635e41c4ba20e98d49',
  '../home-router.ts': '744708f3503d3ef46114998ce9bb6a68b3068a3c7d57e0c264298cdb69aac982',
  '../notification-store.ts': 'd73b922e8e04b1e6415d1c1388bcf75edb4b65c913d3636b9a63e16583bc035b',
  '../unified-inbox.ts': '4ff43026cf624b1e260c522f5fd293533559d3419629ccb847a425e6d19102f7',
  '../inbox.ts': '9af9b9103a285be2a344fa8b6530ed944226146574fc47ce03db3071a5f6a82e',
  '../codex-queue-routes.ts': '6873ee90c32da94dcfebd432535d4170942e53c980456927f9dd57e9917d9a53',
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
  '../codex-conversation.ts': 'c83119338fc5c238f5ce2a6767a36ee7003a2cd08ec0e09bbd96e53f8207db3f',
  '../codex-conversation-store.ts':
    '76ef29aa2d6861db49ef3afa8c41464c9f6f4da1fd556fa949e2286fede0a216',
  // Library profile identity, operator ownership and admission are reviewed runtime inputs.
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
    '59f78245236ef2c05f5f2e9c610629c1f513fedb32b4dae753c6275bd434b3a9',
  '../../packages/protocol/src/agent-library.ts':
    'e5c0e87a605c4f7664d5b9c69411bafc8059301a8c37a8057d3bdf14f604900e',
  '../../packages/protocol/src/symposium.ts':
    '19e2192db110e0fdc3c4c47a2c8424c1614dab48dcbd92161ff2730896cd2c79',
  '../repository-chat-tools.ts': 'd6ad42eb42c0dd88e058c3a971168396a47f1d9a7e58147f9bdb99671f7cd8a9',
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
  // Keychain HTTP/WebSocket credential custody and exact-session approval handlers.
  '../home-assistant-dashboard.ts':
    '1053d482935af066472aedd48365af2b71cb7cf55e30ee88cc9fcf89b96e1d62',
  '../credential-connections.ts':
    'bbdc3c9cb04e298c5f26bc705ce06348ce206fd8b72d83738dd6aef98bd0df5f',
  '../credential-connections-router.ts':
    '6d7b779ff5ba148b6aea43483f4003da0d9ed4908e551a273de5906140c7b96b',
  '../credential-connection-tools.ts':
    '72a3c82b5b20a083f25da06222476feca34bc7419544739c0a65aac73ba17de1',
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
  // The capability binding is not trusted merely because its manifest is
  // reviewed: both the production executor and its OpenShell/Git transport
  // must match this revision before the registry can advertise the action.
  'capabilities/github-publish-pr.ts':
    '559e98cf8f45313e37bf34b4f54c4345bdc9b4bf22538078dc563483750bbde1',
  'capabilities/github-publish-pr-transport.ts':
    '503c887848f3180647b6188ab65b8503bc6670291d4ce865a1b1df1504f15293',
  '../github-host-source.ts': '2720dd0fedf081780ebd64a485164ec5abc6dee7920de925d35e3e6aa647e084',
  '../github-publishing-tool.ts':
    '34042bdf0d666e47dd406779d2e8384e48d60b4c202efb5cad1fe00f5a2e748a',
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
    '97b20d22a5dbdb7b03adba3d85557267b78b088493fa5d622dd0dc63413ab0bb',
  '../codex-private-path.ts': '65e1f4c0922b0e91eda19d86af4d835ff477bad4c337cabc7413d7ed656fb053',
  '../workspace-runtime-client.ts':
    'eb377ad70361797cb34de00c1974952b76cd81041da7668631b138cf5d44473f',
  '../credential-sdk-boundary.ts':
    'd577cd3f4addce8a09ec6e49272196143f28d6e88abf7a4405336542acbf2bfb',
  '../sandboxed-command-worker.ts':
    'f2cffea266ca292c2ba690725820e2c23d4a90fc3ed61619540a960bbfe72f23',
  '../protected-sdk-command.ts': 'e7c59a2ebfd3fde4b0c7c8cdf7f69f9d231e2e5f1819a61e0514cd707bc6c32f',
  '../native-hooks.ts': '5708a6e09129765ab760a6c078fb2571dc73dc1125c9be31b43f1865fe5e461b',
  '../hook-bridge.ts': '8885c2b27079799d33958a17942bb7d8953d01540bf7cd4b3ade537ee39c2d12',
  '../native-tool-executor.ts': '9c2f349a51febe5b8818358f558a67a4e324eda2f525d85a5578e84463f5dc01',
  '../repository-workspaces.ts': '2211f29498e2ba89164dae8d5799e06714b000a963dadb1e3c0f63ef0d741187',
  '../../packages/protocol/src/event-store.ts':
    '822a768cfec8de456570c528e7e4114aab51f0f352a7756b6101c11fa700c6a0',
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
    '13db6d8d468d3e5ff4a9c8feaa06e5abbbb040196e8cf5b94b145297a5393a99',
  '../repository-workspace-router.ts':
    'a9e5e5e60382d16fd7bf8f3c4f3dec6c19d5617493833221cd6c524952f5535e',
  '../trusted-native-operation.ts':
    '0e8afb3b0968881d542850c68b5bc3cb362becffb47e354eccf8375e52ff0038',
  '../repository-chat-startup.ts':
    'da5476aa7e43badb1809a8f52d958d5338ec921c6ab96531978f750fecf4428f',
  // Admission shares compiled connection authority with gateway provisioning.
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    '5ece4812e2a30d7a2a62494d19f9c312f8a3b0174e2a61ac9fc5fb8f72590115',
  '../openshell-runtime.ts': 'e0b5527a4f4dd03752b38e23535b62d2f05e83c76439ab0478369960f7c745a3',
  '../codex-chat-session.ts': 'f0d956cb24b595fc42ec186808b8506cb6182abe4c453e0923703fff79c00009',
  '../connections-runtime.ts': 'dbe641704a1d761d73740260fb28057054fdb34a64513fa77292d2fdb1954a84',
  'capabilities/operation-store.ts':
    '1a235f11d5578880e6dfa7ecf5779e2a011e24430774fc17429d7d22359b93f2',
  'capabilities/service.ts': 'fd8da813303d33f2648a3c9176f75f821a53a78bdadfd9538eca09fd8b623565',
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
    'd30cb48b17c201017eef8e51497c51aaa9a683cd79dc8ee140c09e643d7a7b19',
  '../../packages/harness/src/providers/session-types.ts':
    '53af4d3c4c3cb3d3e3179ca306689aad6faa03669d9ad62d652e21d18babf8b4',
  '../../packages/protocol/src/agent-context-pack.ts':
    '6964f27523d93a64c153f2d3a56650298a2063521abdafffa0c19c3dba839de5',
  '../../packages/protocol/src/index.ts':
    '2d1fc0fcf541f80901e7110bfc4dcbd129b4b5ed92f934ffc1ed440e639b5420',
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
    'fbe437d5efde44bc4186e36dc864b82d50b70780863e0fd45c88216d33174b35',
  '../responses-chat-session.ts':
    'f6d598fcaa493d4d26981a278b768f3472df6cf718bbfca878568f2c6ee67313',
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
});
