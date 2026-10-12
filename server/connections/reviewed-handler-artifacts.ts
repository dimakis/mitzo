import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export {
  reviewedHandlerImplementationRevision,
  reviewedGithubPublicationImplementationRevision,
} from './reviewed-policy-revisions.js';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.76';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  // Original authenticated account/catalog capabilities and charged-scope matching.
  '../symposium-subscription-provisioner.ts':
    '2f0a72ef69ba04daefebe1c98b0dd8dc3b6662ff56fb9874f5ab50b3b3f95da9',
  '../symposium-subscription-host.ts':
    'ab79c9a8b452ec2b82eca3ecbabbade6bdc771306a2c6f9b7159f6d21d7a8ed6',
  '../symposium-work-api-provider.ts':
    'a3c33ff3284b2c6afd1567e2b7ccd3e0850f78aed31b9141614a0c433d663027',
  '../staging-authenticated-account-scope.ts':
    '3dd033155f29408b58dd79b05d275e950edec390382a0b51a2d53d1b3b77a285',
  // Intentional native service extraction and original cleanup identity contracts.
  '../symposium-custodian-service.ts':
    'ddd3dd1886f722a8b6ebec7ffb474d10fc1b4de42f5f52318ac8d0658be2f5fa',
  '../operator-session.ts': 'e05d1098f3725dd1b483b842f1dc5b3ba8b9037c03fe1b8c5897d01334428aad',
  '../operator-request-authorization.ts':
    '2420302f368d9f4291d14aba1acbab9b1e126f9ccc36cb7906ff2383ae27fb7d',
  '../staging-feature-contract.ts':
    '20c4f23c399a1f30f8834892bb70bf59f56ba7be50a689d2c5a1deec8726c52c',
  '../github-publishing-definition.ts':
    '9011efb7b26f32b8647f5e020a8c6e448018142338ddd64adb6f84a158e68146',
  '../native-context-artifacts.ts':
    '6fdb1f39b66c21271b59b919f67f151fd2bfd382910e3cd43265b974d7c9f297',
  '../logger.ts': '563ccb2a9ba950c4c1c8de6c1198622c13bd1c89e7a79d8bac208658cf0b728c',
  '../symposium-owned-host.ts': '0952ceeda0ba856c2dfc58e09345999aed6e3bb7bd5a86b886bbfddd481cec68',
  '../symposium-personal-host.ts':
    '7c1ab92b6a906dba90536df97f18e9f0f162ac176be26f5042a0f5536990019d',
  '../symposium-work-vertex-provider.ts':
    'baca4c97b1cb1f2555cd2fe68191ebf260a9c718a0e4341d37c5774c21602157',
  '../staging-native-feature-owner.ts':
    '70973711fe9f317a082f9cf40898dae7b149799ceda12b9258c5278cccda1b87',
  '../staging-native-model-authority.ts':
    '128a803b95baab65a081557a0706b42466e1b685ab354be148541606fdc844d9',
  '../staging-feature-router.ts':
    '48f83018eb4580277e2532e5008e8b903166e56c910ebdd352d3ddc34f508366',
  'github-publication-template.ts':
    'bb91255da7eaa8c847cd852a6fbf51ff8a539d85b7718702dda591d151018f42',
  'reviewed-policy-registry.ts': '8bd0061f14ad2dd628d08236c0ad621966ffe520e5132f8de668f0d9a069ad5d',
  'reviewed-policy-revisions.ts':
    'e0906353a853828d42f4c3f8010d1b44b5f6a19b4022eb5218f56f27c491ef50',
  '../symposium-attempt-registry.ts':
    'b4b96e3441cd1b146af69f67f4ea710f720b7db95d09a27ec687af9662a2ac2f',
  '../staging-native-runtime-effect.ts':
    '55829efa40d4f08a4fed01d61f11b7e8a7f063412687e0076e407fc2f4fc2931',
  // Context display projection changes no source or provider authorization.
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
    'df641e4ef93a4018d6ceb968b84b76df51921760c2907b8ec45592f3414baa31',
  '../../packages/client/src/store.ts':
    'b1847d1777b7411be8d7446ff5a2c6cdc7c0735e4768470ed5b85f7722539060',
  '../../packages/harness/src/permission-handler.ts':
    '20d09ccadeb668c91008713b45aaffd5762d34c0a6dc1651b3e234732743a7fa',
  '../../packages/harness/src/permissions.ts':
    'e00992d7d86e56d950964a9f6a801f541a425df818a5ff3b6405e2778a1ca0df',
  '../../packages/protocol/src/session-approval-scope.ts':
    'dae13365f4eb821d9563e5a3da65c60135f2081e319a34c7dad3ef27b02ea733',
  '../codex-app-server-client.ts':
    '90f4fc3752b7debd5606a8626457ac3321b4cb917f260da55c6b14741f4acc11',
  '../codex-mcp-tools.ts': 'e0096a9b00db98f4bbc3249dc02603ec7cbd6b53f2273c6fc2f2037ed4b94869',
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
    '03e8f36c3b417e4543dbd3af79c93adbde7f3131d80cfdf8d92a40fea7081ff5',
  '../symposium-sealed-publication-authority.ts':
    'e71d039c70f52a061ecb2bb6779aa4693288965a814d99d75dab0c224f18c8ff',
  '../transport-auth-ownership.ts':
    '945d7eb8ffc97d53d16dc280698ad4dfacae8cb063cc974c269235058b5f7d14',
  '../url-access-tool.ts': '4eea0e50346fe1e61acb1668ea33499651ad9a7441bf763a83544ac7a50a510b',
  '../web-access-tool.ts': '3b0d11abd05a3f86a2dead25caf92343ca7a7d9e402480633482bbbfa0be655a',
  '../index.ts': 'e1fc4a9796bcf7d091aed3f5a93dff0e598719c95c8a6fc6edce7b214b450392',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',

  '../chat-rest-handler.ts': 'f76ad943f1008c6d768d0e8386ceb2127282819714d7655a58f77f8b1a72f4c7',
  // Contributor live-query capture and exact output ownership share runtime admission.
  '../query-loop.ts': '536109be7d7bbdb74f21b521265c789765d967eb871f802388a9e6ec7236ac04',
  '../account-profiles.ts': 'f9aae3553850754542258d27709cb000de2f68d622e2680d956423b7cee633f6',
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
  '../chat.ts': '1e5009f3f2aad3a223cd3e38054cf93334af8eac3032e71231001e90cfe6b6d8',
  // Contributor execution lifetime is independent of viewer detach/expiry.
  '../../packages/harness/src/session-registry.ts':
    '5620e68cbd9b9498cfcf872ed61b4a7f34dd3ff81b45cd4b2acb01d3d2d10f85',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    '327e6572a5c4e41d73d6a4d2f854fc17d5c4049131eb5c2272d34ae1da631d02',
  // Read-only session observation is part of the operator route composition.
  '../session-access.ts': 'e70130c57879d3b22fab78473d90c8d2e787b7a499194c166e7e912fc5cf2767',
  // Request authority and physical review composition share runtime admission.
  '../app.ts': '947fb8e3766faad19733d2d9f2fea6d2a6059c1240d10d25837c0080c8106828',
  '../symposium-review-route-composition.ts':
    '65fccf488a644e090d9ec946bd82f17eae2200c03d7d81420bd3db6f1f03559c',
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
  '../agent-context-sandbox.ts': '84c8be079d154b95201e6da06fd9bf571e155a2bf69e65b6b1f33d113c7a6f48',
  '../codex-conversation.ts': 'c83119338fc5c238f5ce2a6767a36ee7003a2cd08ec0e09bbd96e53f8207db3f',
  '../codex-conversation-store.ts':
    '76ef29aa2d6861db49ef3afa8c41464c9f6f4da1fd556fa949e2286fede0a216',
  // Library profile identity, operator ownership and admission are reviewed runtime inputs.
  '../symposium-director-routes.ts':
    '0c5a78ae46a5cc4df5793e0c42d7dde7be94eb40b771da005895bc998f0dd5c0',
  '../agent-library-binding.ts': '21fccbe6ee53ec292f93be9de3f678b3e1d4e8a8d6e83798678e9da44fadf7fb',
  '../agent-library-transport.ts':
    '72851e7d7c437ccefadf933c3e00d4423eb96ca2bd6d86ba70d5af96c05d2e9b',
  '../agent-library-store.ts': 'fac60510d3a4b45aa34777daf885142e067538726104c749f4ebe533861472c7',
  '../agent-library-router.ts': '91c08e018e542cdd96bdf203f075207272f8acfcf3a0b0ba82ad07b774fd19a0',
  '../agent-library-runtime.ts': 'cc3be2fc2f61053d4430960a2328d41146463fdca701840a92ab65a89b29922d',
  '../agent-library-prompt.ts': '3be39c6cd2fb12c744c5f53e45b8c8b306398146edfcb2af479d4fa1c9159c28',
  '../symposium-profile-portability.ts':
    'aadefe0eab442dc27ce68b86654291299dc6664a185b903af44756f79ff26680',
  '../symposium-profiles.ts': '4138fce2cc44220fa90b3ef65b207b89c06a5f02cd24750a748f79d84d297c95',
  '../symposium-custodian-protocol.ts':
    'a24e231b8e548a29a4ddacce17e577621eb972fbd9b2cfbe831fae122dec71ab',
  '../symposium-custodian-proxy.ts':
    'b4c52b04762ec7122153421de2ae65f9e5c38b803a8fd7faa488085788b71f33',
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
  'registry.ts': '9e2fac83010ae6e4dc0b79183ed49bbcedd359a597186be2af7f5703c12c685f',
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
    '2c6c3d8ca3541ba3d1bc11a5be00ec7f9d6dd7855e09a83aec8acd1d81e47824',
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
  '../connections-router.ts': 'a305954c6fd3e8605b7efe59128ae2b12478ebcabde66b433d901d1549184965',
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
  '../repository-workspaces.ts': 'b7e8cd755cdf6483d706f41d5deca216736b40dbd7863a3be20edfd32abb811c',
  '../../packages/protocol/src/event-store.ts':
    '02119494d980b85188c9d49ec640f7d2510eb573f4c90e7162e8705ba26f37d7',
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
  'runtime-profiles.ts': 'c0b7bbef0ff623ff9b606becedbe309e9d2ac543f88b15ebad3fa20d2a413e93',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    '5ea777bb8c0771dfc00e5b683e36d14f3af797bac7dcc1a3fea35f8c2b9ddc90',
  '../openshell-runtime.ts': 'e0b5527a4f4dd03752b38e23535b62d2f05e83c76439ab0478369960f7c745a3',
  '../codex-chat-session.ts': 'ee49a3226e1d2be34636a44d47dfc4b841fa405bcdaea90a5d875cde462d9036',
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
    'eeaa150add9432bb55d38d178ae674e10277e02931c2f4746dc332dea1ad7b08',
  '../agent-context-delivery.ts':
    'ccb083988e7c0563d9080a8553d9903abc1cf5b1d669b4583c215508faaee46a',
  '../agent-context-pack-compiler.ts':
    'df2afaef1586ea8f56d8cf71fe94fecafd2bc421a1258c898ac5202061b4cca8',
  '../context-pack-composition.ts':
    'cae630948dd56814bda2601f3df7469712074899a53b3ff9017b08dce32638c0',
  '../context-pack-router.ts': '519a8448f281a6c6f2907260596da37227ebfd948d241851988f478b9dccc933',
  '../context-pack-runtime.ts': 'b88bf80b58cdb8bf95dfd950626f75d6e055d2ee5ffb3ac3637e90f85e7bafd8',
  '../context-pack-store.ts': '7e7fce4a09496f735b3ffc9da5aaf9c841a544d1d52513203f2ccdd30e2f837f',
  '../gemini-session.ts': 'feba970944dad01df6e5fd2865e3c1373ef6121bc3dde5835bbbaf4fcd264c2d',
  '../knowledge-library-runtime.ts':
    'e0ad96249c276bf5b640197adda676f14121be592abd88f99d5002fc37838c93',
  '../knowledge-library-source.ts':
    'b0192e3ff56deafaff5b506eb55c6c2325c712e825814de6d355b0fe1bbc3087',
  '../native-responses-runner.ts':
    'cc912f0c14ef4a00c9b93b449a9113a9851eecb9eb899bfba222fb1b324065d8',
  '../responses-chat-session.ts':
    '34a88799051f2c085aaba4b7ef50bee471ec6f4dbae12ce6a158a3dca38f6563',
  // Image payload validation shares native queue admission and dispatch authority.
  '../responses-input.ts': 'b4be57d3535660a31597f07b075070a90b49b2e62239916937e9316e78cc4b05',
  '../symposium-agent-context.ts':
    '5aac047168428af37b9167a9dd4f9eccf91354a76c6bfc3a0907659782e5af2d',
  '../symposium-claude-native.ts':
    '0cd25a86b7d6bdff371753124de13c538eaac03af219f6ef01af48e4463c0d8f',
  '../symposium-codex-native.ts':
    '01f54b879b73d041c8eda2e1d1ff4239086649ee272e0b55b80fd3acc25856ad',
  '../symposium-openshell-seat-executor.ts':
    '74f8428334c14dd0efcf4e8bd12b265ed279e2ba238934f15636c1719aed9f66',
  '../symposium-orchestrator.ts':
    '3a695f4f38a4828c935342930f01cd1237f88233fc2a641e6917991f1bc85d6f',
  '../symposium-seat-prompt.ts': '1f29774555808c5db22e0458f9767c2b498e99430dbd13da6ab94e607291bf4f',
  '../symposium-session-runtime.ts':
    'b9cc941a184ed75b034eafd4562dd304c62e9ffc9d85a25bb3886f253e8b3602',
  '../telos-artifact-tools.ts': '560e27e41df29aa0b5e8a859731bc956b165e6309f9a0974c16da9ee2c2525e5',
  '../symposium-agent-context-authorization.ts':
    '497a2c4bbb4ca61892e392b11fe554bb88d5302921eef7305f88e74d03c206cc',
});
