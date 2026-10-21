import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.10';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.473-symposium-native-context';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-client-reserved-adoption.patch':
    '21e7841582e699dea93ce400e5c5de72459e6951ac19a9dc2c2272ee5c6d54e7',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-retained-source-frame.patch':
    '83f8f0ae995e23806dd0c1c685f7a8cf837ff4004e38a311421acd4b08d3d10f',
  '../../packages/protocol/src/agent-communication-store.ts':
    '7a611a0953117b064f89e966c5520dc70598e6856e707ce735e8419acfbb4753',
  '../../packages/protocol/src/agent-communication.ts':
    '0db8d30742b3ab664708b6a91b5eba2b033979c37c729cad77e598e0418c2409',
  '../../packages/protocol/src/telos-work-controls.ts':
    '5ed0945a92524675e6be14c772cc44949842e3d60430fa7f40cca479cead87be',
  '../agent-communication-tools.ts':
    '13fdcf3e970907991afec89547d29746ce3d73cae424448993d89f8ae709b0b7',
  '../telos-work-control-tools.ts':
    '716f889418970118c872d70c8718f4d268077fedc299f002b72446c205ef3b7d',
  '../telos-work-controls.ts': '2fc2b2894eca7ab3457734acdc44772bd6de406d3b322939a488e762f0c92c29',
  '../../frontend/src/components/ChatStatusMessage.css':
    '1d0b6c7958295038207dfb7d2bd310e0be2e897b25f81094569003bee210ee53',
  '../../frontend/src/components/ChatStatusMessage.tsx':
    '1af936451abe0baf0f0a28536acaf66d5aaba3c10c83996286f4ca627732675d',
  '../../frontend/src/components/CodexQueueStatus.css':
    'e6fe728282f4c522a33bc71128880ceec14c0bee1814f061d88975d699295032',
  '../../frontend/src/hooks/useFileNavigation.ts':
    '2d0a2969210ac8947dbee201b20d6270f835c8a5d1e466b44bd1b299c13e41c1',
  '../../packages/protocol/src/collaboration-source-setup.ts':
    '721a2ac2183d4ca5e9f73aeb6657bb8021c173440a799299f668a88621b28eb2',
  '../../packages/protocol/src/collaboration-source-setup-owner.ts':
    'e65e3055e3e35661b537137ca2758f3006c5af72003d5dc2460cebbdd0ff969b',
  '../../frontend/src/hooks/useOrdinaryWorkspacePreparation.ts':
    'f46b3eab3dc2cdf7aa2c86c66e3105183a0393615a148bac85aad7c59731ec58',
  '../../frontend/src/lib/ordinary-workspace-preparation.ts':
    '495b3ca8f62ea9fa668c9f05742af38ef7754f5a81a25e8c5f7b19aefa65b990',
  '../repository-prepared-command.ts':
    'f6ef0586e88e3e325fdfc151fe8809619bb6b9d38b10615e450c6b1911ecd502',
  '../ordinary-workspace-prepared-command.ts':
    'c8d91b0bb39c856032797c97d6a5245bdd759b6037b5f3cfe08d50ff018ab1bf',
  '../../packages/client/src/local-command-delivery.ts':
    'd00bb3c218edd6b0258a2743805726c18733d568e2248786d5163fd201453876',
  '../ordinary-workspace-artifact-root.ts':
    'c8432fa77fc88b058c0a62a8357d0a816da8ce2d711fe09e6de7e6705fff570c',
  '../../packages/client/src/ordinary-workspace-api.ts':
    'ee09d2edd4bd49a9f65f5e5461127c0587ec64005f45967989c9bc698d45c76d',
  '../../packages/protocol/src/ordinary-workspace-public.ts':
    '5c734f39b24e515f18bea7ccfd7e703bb405e6e0b3f6e41c69986bd6dd45c06b',
  '../ordinary-workspace-router.ts':
    '6b206a0db4fccc98eadfa1524f67d559abd117ff5d1f67b5ac74f479f7662eb9',
  '../ordinary-workspace-runtime.ts':
    '9e15117f959e1ec6a83334b936d2aaf9ccfdf46c82d6e087315dc1e1ecb71a1e',
  '../../packages/protocol/src/telos-ordinary-work.ts':
    '4d055bc77797f41e742ff6940d5019d8637517322c609b9b6605d3160fc1fda6',
  '../telos-ordinary-work-role-setup.ts':
    'e6e51ae8dc5b25e14bc6d5addd8bcd1da2b05eb49f631def888dcce8e4d83254',
  '../../packages/protocol/src/ordinary-workspace-session-store.ts':
    'a14a6deb297b3a378c47e9745daaa5bbcac272a74ff5077530472db1378ddb67',
  '../ordinary-local-workspace-owner.ts':
    'e2fa568c1cabfc6a3ef096b025ce115048e83a388812c411f83e30c22052f057',
  '../../packages/protocol/src/ordinary-workspace.ts':
    'c4431b3fef376cf17142c07764c032d0147915893c0b49c1776b0ccccc08c808',
  '../ordinary-workspace-custody.ts':
    '12340f543594f8a4304b7e59c86e02e8ce146cda7f9fce2e645e47b8ad8fd947',
  '../connection-request-error.ts':
    'baedef9cc52b1ace3c705fe396f4a11e938cf7f018d8ccd2ad28f699f69d098c',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-model-publication-guard-clone.patch':
    'c7b35f9c8851a5ebd8e6d98847f07e237ff59a3c5c7f3f2c17606e9c770c8ec7',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-model-limit-catalog-owner.patch':
    '54ae4cf67c005f57f9dc70d4514bf5d0abe59e774c15296e170aa87fff96031e',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-pending-command-fixture-identity.patch':
    'f4f113471f2404a412a0bc7d6a261c39c6fca373c7c258fd2c42ef69bd7ec2a0',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-effective-mcp-registry-policy.patch':
    '8957a196d018d3ba59619b114fb6e92d970d884cbff5bfe19028908e02c7f6c5',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-pending-fixture-explicit-assertions.patch':
    'f3e45065d91fe1032cf6b1d62cc96b3c0084fa72b9871d4d82f8b9a2e5993d8c',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-guarded-commit-durable-observer-fixture.patch':
    '5a2aaa1e9a208302a340be908891aca7dd55bc478b157b2d1962e488f7e77070',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-synchronous-pending-commit.patch':
    'd7b3cb3539c683b25b2c6027dcad96442ecaa3657329bc354d1ea4de6c0e8608',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-ordinary-credential-cas-owner.patch':
    '2f59fdb4595e3b22b38e8e1208933bbf156684ee69f527ed62b1b7d042b29393',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-pending-effects-release-continuation-fixtures.patch':
    '7662c7227acbfd318b78c5cb20911e2f57932928fc5f4a5ef05372f7a0bfe673',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-disabled-notes-goals-plan.patch':
    'b17af851bb494fba61d6411232cc9464eac9688893ed952cb4c5becbef39735b',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-pending-request-effects.patch':
    'f03c4a64379f57a969e22922cf5a6c2dd1173016d6481c7ad5b27610d625cd6e',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-public-observation-policy.patch':
    '8f5233d49f70121af359b927e07d5512a19a2c61fc63830fadf266c0c32e1d6e',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-public-thread-source-policy.patch':
    'ba5d21d6fc16149e19e64cbd7d7e9c7099e03e6c352cdb9f2a2b4034127bf887',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-utility-tool-inputs.patch':
    '6a73f20f0f2289b97112c74e7e12c337bc48a4dff491785f3d401c4ab932579b',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-cached-api-credential-guard.patch':
    '262ef01063573f018b17d0505820abfc97d6ba8915963cc05e1a52a5eb65e002',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-ordinary-public-body-owner.patch':
    '994569a82900e0ab73ffadb21e843646a774a9cc37ad16c640c3bcd1d1155593',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-shell-resource-tool-inputs.patch':
    '6f1433d2b79b4d64a1b14ed92e2c441e74684eb17235970ef758a4c645cf9293',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-collaboration-tool-metadata.patch':
    '0f1871b61e2ebbf2859a71e4b22b5c21f6f9343f2335921f28ce696ea2dc9d24',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-resolved-tool-mode-policy.patch':
    '6cb315d05029eb418e4ea8164c594b2e033470bf9fab1c21b048cec03099c1b0',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-model-tool-exposure-policy.patch':
    '5aa1ed593d6cdd263ce5f135e7d5e0a4bd31bc55ff00657534174931b2ba60e6',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-resolved-code-mode-registry.patch':
    'c2df00cad6dacf6c59b636b9ab9770d8a747fa1155ed4c3cbf01c6a7d8aedaf6',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-closed-mcp-source-plans.patch':
    '30d053c658d61bdc85042efafe973dba0528f26414c14f749442b880f43de7a6',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-fresh-mcp-source-inputs.patch':
    '949e4f19bf4c32049d90b11495e813e6e0f5f82c20c2b36e62a35379ae0b1d98',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-pre-session-reserved-id-refusal.patch':
    '84c0d3c35d287c632824b8820771356b3c7a137ff152576ed101939abed1a706',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-single-attempt-transport-factory.patch':
    'e9271989d3f049db349fcdb3b7eb16de152e504f70c787be70fc10ad87793f1a',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-config-tool-selection.patch':
    'db6533f613436bd2981f0babee2bbae2c04bcadea261ebe5b81292ed757a4a23',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-configured-memory-web-tools.patch':
    '446aa08a81cb866b82988f75e800d40d4e2ed12103ac518367884f450ca403af',
  '../collaboration-application-delivery-authority.ts':
    '55a272d355edcce188891e57d0b585941fd56137d3cc7bcc71e3bd9f64ca4dec',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-extension-tool-inventory.patch':
    '4f7da79a4723d70cabdc576bbf34b0bb9c18ba0d933758dda44dc8b228248124',
  '../knowledge-adapter-cache.ts':
    '72fff2292ec104451c3e18ca896f4eb1648ad8be3d472b9fc5c303bd8be7b199',
  '../knowledge-prewarming.ts': 'd37faec60aa617052fc5db01466aee767e494b3f23ed23529754503d8d33dcdc',
  '../knowledge-store-config.ts':
    '690c67fa1c47ca08da5362b201b571619c74557d8d6d7f1da87d7a7c9ac8a54d',
  '../knowledge-publication-bridge.ts':
    'b4c40483f852a4c0f17dd5fbf9463353a6695bccbdb71adfe94f6b5be5187d94',
  '../../frontend/src/components/AdviserSubscriptions.tsx':
    '568a46de4fc1202e3304220ddb576092882c9a308e5e2080471e89e0bc246466',
  '../chatgpt-plan-adviser.ts': 'b229afb3cb4b9517c58d23d826d7a0445b8c5f5c70fd6115f460793a60a33534',
  '../openai-account-key-authority.ts':
    'd4a571994677ce42996f77b359145d3ecc0a8428bdab0284cbfb17072a93f23c',
  '../terminal-plan-adviser.ts': 'dfd8232082bcdf9b149bd4100b3ae8c82b5fe9f1a663095ca7d337feadffc6a0',
  '../terminal-router.ts': 'b1a4968bcf4f73146f6d49cb73e97a259d7734575e42e163a8301380ca36e057',
  '../knowledge-draft-store.ts': '1d412689921f7a04a10f7f4842486321bc970d9b9ea6f6a983ff2a948094b639',
  '../session-knowledge-tools.ts':
    '59259c7ce42b71ec35e59aafe80b2f14ec3ee3cd294f3abb0983dc7cd83c95cf',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-trusted-root-child-cwd.patch':
    'fd6c6b41ad2510228d7695381207151a0c94b323400ea7e8ac58ec62be02e970',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-trusted-root-cwd-observations.patch':
    'd9ed9ebf62c3dfa5959c694f603db0f7c740198792d7bc5b37b72a0fc18ff89a',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-parent-diagnostic-import-facade.patch':
    'e3a5529f2ba38766d1b4d027adb001d3d0f0a3816ffaf3792cc63e3b63793d52',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-parent-refusal-observations.patch':
    'b04c504be3e0021469059d1395169f887b0795c17e9e67e37376e894a0062e97',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-parent-terminal-denial-fixtures.patch':
    '6615a0947fac018fa1666e3dd8ef6bcddb7cd98cbd4891eebfa8ff728cdfe0b6',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-parent-routing-cwd-compilation.patch':
    '7bcc571141dcbffb65c8df2489aa272985a1ada531248473c1099bac5fff4694',
  '../../frontend/src/lib/todo-priority-save-state.ts':
    'e93f017a4d3df6c44ef9955ac7ab8dc3de5ff1637f78e647bd1e2fe9e14f3dd3',
  '../telos-work-role-presentation.ts':
    'c8d13d62830b3df88e0932ad116d562225e916088a453a0a447339b4122d09d0',
  '../../frontend/src/lib/telos-role-presentation.ts':
    '70c76d0f835dbf625cb6ea0100d1a3c03b938f7564823e42240f3afd239ad558',
  '../../packages/protocol/src/telos-work-role-presentation.ts':
    '99736d144a8086119d3defb90b79a0b1b8635772a2c8d70fc96034df59421417',
  '../openshell-runtime-migration-adapter.ts':
    '80de415c99219bfa5f4b371ef3ab6b247f22211610418bce69e2980dae58e431',
  '../../frontend/src/lib/conversation-joining-application-owner.ts':
    '6f94fc394fa740a1e053770232954bb091d1589750fe35e028d2043f2ffed314',
  '../tool-builder-runtime.ts': 'b854fbfa534a8d47f249e1ba8edf65009719ece8c2718d213f29589001e47f05',
  '../installed-custom-tools.ts':
    '103aa54c9df80d683bb0a8f58fa296970e5be0bad0a37acb3a7b2b7e32079af3',
  '../custom-tool-admission.ts': 'e226167e0de3de25e01f734686eaa97a8c0dc69a43fe3e6623a1b9f7a55763b7',
  '../session-messages-route.ts':
    '9564ae2343dbce4297e6bdea7a183daa2b63e6df8d747e143d9439f5cd4f998d',
  '../../frontend/src/components/AgentTaskProposal.tsx':
    'c431e4b77b6349b5f6f2b8d2d0040a5c970a2440c222d93577e0848451499f2a',
  '../../frontend/src/components/SymposiumProfilePicker.css':
    'fd2ab3e855f3cb1e1814de4e5c7206f1970fe9739efff7fb6e21a7df0390b310',
  '../../frontend/src/components/ToolPill.tsx':
    '7dcf00112046cac43b0d5186b286d2c3f58bb79d4da7992019138b308633d903',
  '../../frontend/src/lib/agent-task-proposal-link.ts':
    'c6d0636d69ea3fce109df49793011593761d7cfa34070818d92646f2a920a51f',
  '../session-agent-task-tools.ts':
    'cec0cb43a8158b9ded3f1653678c93580f8766422cefc1777dd1fd0274a2c67f',
  '../../frontend/src/components/TodoPrioritySelect.tsx':
    '44f5256063273e7fa9a061be6bf81a497bc268f45c87d36bcffbea7bf1dcf032',
  '../../frontend/src/lib/list-cache.ts':
    'aab8fb64d2ba643e5dc69eb53b9fddadc7680589ad2e7b5b05e3cc71672e0037',
  '../../frontend/src/lib/todo-priority.ts':
    '0d94d14b2ebef076eef35811513afcde789c6f9f95f0f18d14515200ba439ad9',
  '../../frontend/src/lib/todo-utils.ts':
    'ac071496fb4986ec4b4395384ed7777b96a01a2706ec31ef5766464362363bd4',
  '../../frontend/src/pages/TodoView.tsx':
    '2167604b009efbb85467ae8ac50c94efd933b2d355a55df0a208136f0156806d',
  '../../tsconfig.build.json': '88fd99085eaecacd39e0d1464b42f00d622a0a5c356ca8ae035ff72ca7336434',
  '../../tsconfig.json': 'cae7a19ce257dcbee4915ea3e51c78f131323bb9ca98d7b4302ea9a0de1b2f66',
  '../tool-builder-test-runner.ts':
    '609f8a11772a4c4762113a3a398347b1b23b4626890d2e23990f39fccbc4993a',
  '../tool-builder-workspace.ts':
    'e500e29c5412c8954408a3e965572128300f5ba95de997cc02479452a936e1be',
  '../terminal-service.ts': '4459f9c19c299b7c84757b94eb05dd177cdacbb3b605cf3636ba9e40a53aa334',
  '../internal-token.ts': 'ce49a6b2bf67edae745f11b33ece462b871c410d8fff6a4ed6edc0b5ab365f37',
  '../../frontend/src/lib/conversation-repository-label.ts':
    'd995d0b4bf5b26b364c6d1bdf98ea5e591716976b436f134e5952db3cb97419d',
  '../../frontend/src/lib/conversation-joining-recovery.ts':
    'c7ec0d30a4cbc9068dca72438a2d0a88eb87d18b293457b11948988409377a35',
  '../collaboration-application-review.ts':
    '8b44bddf29078d9479c940b0ed00124e3435afcda6972fa71131c3597ca3dadb',
  '../../frontend/src/lib/saved-artifact-location.ts':
    'b884336c70dae85d63d955fb9d454f4a7cd28e8e9d2fca94e3839b7e6b6444a5',
  '../../frontend/src/components/SavedArtifactRouteDialog.tsx':
    '60d77cfbcd42e901886260edce142a0a533d8123fa51a7d62c630753a7d09165',
  '../../frontend/src/types/retained-artifact.ts':
    '6ef0a64da9c950556519d8625b0aea2fe8d9c94f9b84a68de9e9acfe9f75bb00',
  '../../frontend/src/lib/retained-artifact-api.ts':
    '4db9e055e7b8162399233c010387066a189ce94cb8e8396ef11134f6a2ec6e9c',
  '../../frontend/src/components/SavedArtifactDialog.css':
    'd42d2f0316e0c3f2e3828cc73bfad511e2bd7dab44dd826566fa39efca0fe982',
  '../../frontend/src/components/SavedArtifactDialog.tsx':
    '4f3cb5204c11db0ce409eb7469e359cbbd5440c63a09b0ab9ad91b3e99a70ce8',
  '../collaboration-retained-artifact-source.ts':
    '817f3b03bacbec5ca607d04c352e1271ebc87f93b668f92054c443151858b2c1',
  '../collaboration-forwarding.ts':
    'c59e30f6d9dc3d91106491e7848c18f4d62f8dc70b88e09fb1bab72e5364a4ac',
  '../sandbox-ownership-review.ts':
    '13825b93677cbe7bc7afd8059abf71e0cc47b79c3b534beeeb7feb6541ec8629',
  '../../frontend/src/components/SandboxOwnershipReview.tsx':
    '64e5c10201281d54c61e62bf06b1260aff990939f38cb1b4052ba6335d001e0b',
  '../../frontend/src/components/SandboxBatchCleanup.tsx':
    'af232871b17f95cfe1cee1bcd7031236cad69ba7db51645af07e084823e247c3',
  '../tool-builder-schema.ts': 'b55fb292b80f3f1c5ad9376a27abaf62b901cdf07e5fb62ce07cf7fbc17a419f',
  '../custom-tool-registry.ts': 'dbfc32113c4af78d5885e77d1dcaebb10f82cc1931c552aa9fc829e996ffb0fa',
  '../tool-builder-router.ts': '098b60cbc463a81cb3a43fa45a6fcd0ddba309ae6c4ef1ba3b69a26c2c916bd5',
  '../tool-builder-store.ts': '26ec2fa2c3bccd7a2c1fd41dbf4a0b3f10116ff97a3f684a502445096da06e3d',
  '../tool-builder.ts': 'f086bdabeac717acab30aa0433a5b2eb17cafb82ec56126009ad6a5a58a01b61',
  '../symposium-access-tools.ts':
    '2f23fa9312b2ca435bfb6e2d1659d86e4d532fadffa02b2461c59d02e1bcaa54',
  '../../frontend/src/components/QuickChatSettings.tsx':
    'cbc362221b4b23133a708f2d99b41db97797254aedb2a25547f30005ee91dbe6',
  '../../frontend/src/components/QuickChatSettings.css':
    '9b58f5187c14f0356d49296410d6e763707544176d38583c031803a9ed7284a7',
  '../../frontend/src/components/SettingsBrandMark.tsx':
    '74b448995334f1d9b76bc0348839e83ae860b7fd249c389eee6f2ff77c42e9c6',
  '../../frontend/src/components/SettingsBrandMark.css':
    'f7f5f2bef17dc218b04179dd8e6f94311c0520f64ef40343c7b44fec6d4f31e8',
  '../../frontend/src/lib/quick-settings-context.ts':
    'd0fde0a0dedce0bc4e2977a49a9758f52be228d1491c4b864d27d6cdc42ee96d',
  '../symposium-custodian-main.ts':
    '68a9235ca4c5d0a33b84a4a72b92165a9dbc00f9375770b166270ebb9ecdd699',
  '../api-tool-router.ts': '2b95fa7fa918be7ea1b59e04293d7fbbd80e55ef719d1b0a90e65ffb2e0b3eef',
  '../../frontend/src/components/ApiToolEditor.tsx':
    'e6aac080d46dd546dba357f89977a333b4edb23ad1d518b19544b0c3909fe070',
  '../api-tool-runtime.ts': 'b81ed9f222e6b6aea47425b4fa33511c26235e02e5c548221522bd2cae43ed6c',
  '../api-tool-execution.ts': '4b2517a35fc4205667c4f974d080fe7e876756352a3a73d32fe405f1a56b21a8',
  '../api-tool-template.ts': '32908a45ddeacada75dfb4a1d0e8d2370b3fe441fabf8dad3d2fd3edb8eb8c51',
  '../api-tool-catalog.ts': '69fd31ac8f13b135ebfd8faf8d844ee4ee468bcc79ae68b186f3b12ecd70df73',
  '../public-replay-error.ts': 'f259c0724784f96d7553750a6ca0d5812ef69d934f123b47eeaa863dd530aefe',
  '../provider-failure.ts': '0655ed00d881906318380ec0c90d62f1457b5257747eb765d05658199443805f',
  '../telos-source-recovery.ts': '91d1921366236f855fa2283fb35aa64641d1a2b589e5b2dcb7c24250d94dbb91',
  '../telos-source-approval.ts': 'b41255c62a3a6dcc091ccba0e2715bd4ec436ac2d1f54ce0011358cdd7f88720',
  '../telos-source-approval-store.ts':
    '76d9bddb52be7b2ddc55f0026d26b6fcdde0996684d551f0364b16060a52f4cd',
  '../session-permission-policy.ts':
    '0c3f4a314ea87d9e9fb55daed501c0958aca664cd6a3ccda22c4fbe07c7f99fa',
  '../../frontend/src/types/ws-messages.ts':
    '7a380fb5213533ddd87da2bcfc202e1a6b5cf6b02e34ca73c9310e9007d8a77b',
  '../../frontend/src/styles/global.css':
    'ae0e1ed8ee2c6662e53f144b0eb232d585ceea93dd20b99ef18b06d5b13d921e',
  '../../frontend/src/components/TelosSourceReview.tsx':
    '5642df0dde7a425b2ceb755e60a77036a954e6d5fa1af04e0e99f7a087b02107',
  '../../frontend/src/components/PermissionBanner.tsx':
    'eb59c9845314bbb0f1b15a720361c8fcef7678e477cb36d5b2be093212760825',
  '../telos-artifact-routes.ts': '27c18f41fa4f750b97c7b7527d28628d1833a4bd51d9a5bb1fca65e098ecd5ba',
  '../../frontend/src/hooks/useTelosSourceNavigation.ts':
    'b2a461e208923889e0286efdd3faa41705af58693de41446aa6021eaa4b73fd8',
  '../telos-outcome-handler.ts': 'fd01a401e79d08b8330aac5da419d11c49e07d767edf2bab34bea990cf04168f',
  '../../frontend/src/types/todo.ts':
    '40ce25d2ee7d5bb6f235d440cf3b5f6baa8f5760c92d4f0856276c6748468cbf',
  '../../frontend/src/pages/TodoDetailView.tsx':
    'c44c0fe5f9882518ccf7695594f139a88a3e71bd71b26ba353355764f15f9a64',
  '../../frontend/src/hooks/TelosSourceNavigation.tsx':
    'dac7bb547165c32a1c14f023a34ed371de281c9fab1c9ab41a93f522f6d60598',
  '../../frontend/src/components/WorkOutputs.tsx':
    '47933708c3613e0815b1fae093eb0239b8e8905edcc09faddc409b7ee13d6140',
  '../../frontend/src/components/TelosSourceWorkLink.tsx':
    'c1390c9b009c2aef271379608f667ffa6d520bcb87c4ce6bb1ae12a57aed8bc8',
  '../../frontend/src/components/TelosItemSources.tsx':
    '03abba949c3cc42c377a136c268f049d74fc2a858821af07fb7ef26f59271ebc',
  '../../frontend/src/components/SessionWorkLink.tsx':
    '2f8f334d977d32d40d2226831cfef7ecd2f06a755b3240c2f0cf4e27095f28e4',
  '../../frontend/src/components/MessageBubble.tsx':
    '3c9b7018e4fbf623dadca449596e6025a8f633f72e7677f0c59b4bd5f14824b2',
  '../telos-outcome-owner.ts': '7e11bca759dcda14dbc766fd7a02d1a05165a7333d8b78368555145854740161',
  '../../packages/protocol/src/telos-outcome.ts':
    '2e02bc7096e531552c3eeec437f4e777d5b9a14089c3d6a9eb00b5d7942bf758',
  '../telos-source-routes.ts': 'a1ac1baee2f27786b0f0a2e62387df5935aabfc888c468fe3e2cb085e9f9ceb4',
  '../../packages/protocol/src/telos-source.ts':
    '6ca8887c2d88f73eb14a5886e441da54c0036f0767392f4e72352f783d33eda7',
  '../telos-artifact-store.ts': '43e658aae82414b2fc691aa75a31b82cc8341df0b1117e81ffaf2709a264a4ca',
  '../telos-source-capture.ts': '2827e66ccf2fe5f4732d95af4a5ea8f06769c52affee015d6a8883ec484d9b60',
  '../telos-conversation-source.ts':
    'e420c1bd9aedb5173520eff85f8a13c0e2754c6bbc3ac112cf352e1c57307be3',
  '../telos-work-record.ts': 'd4dd614b57f74c5ddfb5386a1ea252abc4f1210d12a633b60dc538f4712b2b31',
  '../../packages/protocol/src/stored-event-wire.ts':
    '299edbeb86bab57c9f910b27cab5d6753ff026106916d58f4a9a2dd5deedafa8',
  '../collaboration-ordinary-replies.ts':
    '599f1574e4fb2deace9d5b0aa19e639d6bd7aed727837d404f44ff916eba8a5f',
  '../codex-session-events.ts': 'ac907391d5427c054eb4b2d5d64e28c853b5b5c52cf5bc689467aec994e532d9',
  '../collaboration-context-source.ts':
    '47b8f3a48982779c976955ff7b48c07239d65256bc8b6a22d07ae65ccb98bfbb',
  '../../packages/protocol/src/collaboration-visible-source.ts':
    '8747b800cf069cad636dc5ae6e92a347e55b59c9f01fe64af84587e047af1567',
  '../telos-work-conversation.ts':
    '6abc340f3236812d9e9875e8a60944590575d991e95ccaf3f2b61aff323c5175',
  '../telos-work-routes.ts': '341ca2354c075caf18b79865d8cc520d3ac36284d9b47bfb216f90c651427677',
  '../../packages/client/src/telos-work-api.ts':
    '3e51db24e9269fda0aaeaaf1087ff1b3a388692c98d463792941fdeff0761692',
  '../telos-work-schema.ts': 'e9b33d372356ca81d1bbe558d9c3abbfd60dfc8b6123893b9304287076c97d45',
  '../telos-work-store.ts': '67cd4bda85bbcf3b5ee7343a23743d6bffe1068cda2d12870b30204c02800e05',
  '../../packages/protocol/src/telos-work-api.ts':
    'dfed9673113e8f532a253b57ea1696508e339bbfdd83ab98fb2e791a69daf27f',
  '../tool-input-error.ts': '3fa8bc111278d03dd33014cadc8535069c49a12ce636cbbc33126b76190bd3dd',
  '../telos-tool.ts': 'a21d66aaf087d882b78403d335453effa8e7411220d5537b71ff0c271cf9e824',
  '../../frontend/src/lib/browser-crypto.ts':
    '5d10eb99cc0f0d8cbabd7eeefa9ce245bd14c8f32921edbf197a13f4b849b270',
  '../../frontend/src/components/ConversationJoiningReview.tsx':
    'a6796ce07f03725ee489681fabcd9b545a4b8504261290945517590e5470319b',
  '../../frontend/src/hooks/useConversationJoiningReview.ts':
    'd55b2009abb0aadc979dbd17f180ee2b766f4e2cb7fb60e9a54e0a6659cd74ed',
  '../../frontend/src/lib/conversation-joining-review.ts':
    'e25462f38b4a19de42a6c4533b56967b49c59f504e668cb1fd670ed43a554442',
  '../../frontend/src/styles/home.css':
    '284a0c689b4f3071b6e07e097e89cd03f90fb7d4ee6d5f3a956bd35cbe588556',
  '../../frontend/src/styles/tokens.css':
    'f028f328310f111d619e015e09774c02e5caec9049863756d77095425b82d97f',
  '../../frontend/src/hooks/useMotionPresence.ts':
    '355c33e3465657f632910580edf7a3ffeb62648416671e6e6b1811a062d04b6b',
  '../../frontend/src/hooks/useReducedMotion.ts':
    'bac83b87d2170b27345c415117c7ec3af58071633433e58c0ac57b4cfe8318b0',
  '../../frontend/src/lib/motion.ts':
    'a47d7b84c9dc21c89ee09852d35ce84ed3e3ecb6e2fc5eef1359d574b4813e0c',
  '../../frontend/src/types/account-selection.ts':
    'd866165714758849b0ac5e5d578971f5f12742494b747b04bd1d31f0045c9650',
  '../../frontend/src/components/ConversationAgents.tsx':
    '7c71c29c3bc71dca06d0a0bfe131ddf72c71881e28ae6662ed1c19b9fff02a61',
  '../../frontend/src/components/ConversationAgents.css':
    'd1b97f4a9730544f87d86a4688bdd28569c1d3b8a68212316f8f54423475bf36',
  '../../frontend/src/components/ComposerResponders.tsx':
    '1d9d03fc824c8903172bc7216dfcdd7bf0275092315b824f583d96410b900c76',
  '../../frontend/src/components/ComposerResponders.css':
    '29b0c05f64bc8555d35a759c7054a950cc70f57a7b49510262ae3b3b1e51f97a',
  '../../frontend/src/components/RetainedConversationComposer.tsx':
    '6be25f820dbf6770f063664ce19429fcfc986547cd8ef397f996a4294b8317d7',
  '../api-schemas.ts': '1f036d99280f706a1a0aa5bf9115bf748c57654afc16d9e1540a3f3b79374961',
  '../connections-store.ts': '0143b2eff9725aed9e2d483087719733174974afd26486eb32d7f9335788c3bb',
  '../collaboration-context-compiler.ts':
    '917b32aa231511e6391a7e722723642794a547aa1b2e543ab86d99b889d184b6',
  '../../packages/protocol/src/collaboration-forward-custody.ts':
    '63368fb15184ad9424eb91ef60a6bf8d37fd9ae67a6305eea46cef8e34d56d95',
  '../../packages/protocol/package.json':
    'a61c766103f7c7ba441d67bc52ea1d583e42f57ba8ad1ca2c90d50bdd25fb746',
  '../../packages/protocol/src/collaboration-forward.ts':
    '24fa815ce9f2b2673bfd4e656c455b239e5ad2fd26d22a3d5bbe51fac1513ec5',
  '../../packages/protocol/src/collaboration-conversation.ts':
    '164d36d40da9e5ef983a7714f0b0369d7714c111bba2340a6504815a044297b3',
  '../../packages/protocol/src/collaboration-conversation-store.ts':
    'f5ceb2396c016d3fc29364c93dc18175caf98b1eaef8d647ba473820e8d2fd2a',
  '../../packages/client/src/collaboration-api.ts':
    '6a2f8b6270c1970a7c44388fe5f42b0ef33bcd0d54067dc76ee018cb83fa6739',
  '../../packages/client/src/collaboration-projection.ts':
    'c1c4ba9954434950444389c70be7c1f31460e5fcddc4d99d6edfd74fd113890e',
  '../../packages/client/src/index.ts':
    '0cf62447cb182a9943c919aeaba30c149ccf033bd97cdcebc5f7dc3aea652727',
  '../../frontend/src/components/CollaborationTranscript.tsx':
    '8ee161094085371f18635afe511b37c9020bc6a87d76cf1103e77280bea941ab',
  '../../frontend/src/components/CollaborationTranscript.css':
    'e617da58d37e75e41c4f165ff976675017d4bd650c8949a6b0f2f4fe1634c392',
  '../../frontend/src/hooks/useConversationPresentation.ts':
    '47560f74a0d68206cd2bccad8f6a8e4621e6352bbe321845663444c7faa69bb6',
  '../../frontend/src/lib/conversation-presentation.ts':
    'cc15c8961398998acff1315699feb77cd614278d9109804b5f1495d796a5d9bd',
  '../openshell-cli-environment.ts':
    '77f66ceaffb019038fe06479459505dbb37480b7791c596c8e869bef14c2b456',
  '../openshell-warm-pool.ts': '9af589d6c38ce39d122a9f5d55b5e7c34a977ca6a040918dd7d6fe6321958f5d',
  '../openshell-warm-pool-runtime.ts':
    'f3090664b76b721494f9ef061f89732866d9696ce3c5f6172662c832a88533d4',
  '../openshell-warm-pool-binding.ts':
    '498030ec01afaa475f3e869974ec1eba1465eb537e14c06221e2c217a1e11583',
  '../openshell-warm-pool-router.ts':
    '6915cd60cab521e2c8a22eeb773c348c277b30f4ad4cb337ec3615e24f3070c8',
  '../openshell-warm-pool-host.ts':
    '9760df035a16060ed3720ed621ca2d933643dcd3914936f4e54e52a3daf49578',
  '../openshell-lifecycle-service.ts':
    '59ba987486c5cbab33029d6fc14321dca53031c6ae382b0128c3d54b01ace26a',
  '../../frontend/src/pages/SandboxesView.tsx':
    'd9804cbbcf7e42c58f64a37f401101ed347ca8286c8776d82f8220dbd348b95e',
  '../../frontend/src/pages/SandboxesView.css':
    'a130773778bd77fcc144c1ce67d30088d65398a29fd1676906ce99b273bfdd9f',
  '../../frontend/src/types/sandboxes.ts':
    '1f5a4b6bd080363af3a1f77ea246be04894cb9893b0f021353d723658a9f10a7',
  '../../frontend/src/components/AgentToolsEditor.tsx':
    '185739f065ba2ad81534a2b171239d086010447fe03e3669d920dcd13804b5b1',
  '../agent-tool-catalog.ts': 'c04824826a52a68d440a7fc6e1cbaad0df9fad0b78a7e623bde323508716937e',
  '../agent-tool-selection.ts': '6ef32b850ba81b4eadd6aded850988e2f29ecc4e5cf64692456447c53ba84105',
  '../../packages/protocol/src/agent-tools.ts':
    'a25c3fcd8a885db213c6528fe9e07fd11da6744304420b4f3affd2e354d1af82',
  '../symposium-session-create.ts':
    '1696f970ee8d8680ce3d73f80cc06b5712dfe78159a1a6635cad81f24e040640',
  '../../frontend/src/components/AgentTaskEditor.tsx':
    '003b194d0d002587af01d0c9e9b62e1d272d9228ae7a98f9fbbc8edf42f8433b',
  '../../frontend/src/components/AgentTaskList.tsx':
    'dddafd483aad19d3e6267a69b318640f592b645c6236627a1372074756386366',
  '../../frontend/src/components/AgentTaskSettings.tsx':
    'd8b931037fc4f4eafa71af6c7073e5d9f78df19607949138174e902e27146414',
  '../../frontend/src/hooks/useAgentTasks.ts':
    '0c279c93389daaa51781864b8254e716f6e76fc5422e4c8580d4e026ec433576',
  '../../frontend/src/lib/agent-task-working-copy.ts':
    'ff73a1b51906400257fd8502f77ea46d5835a06c9004636ad10d1ccea156cf24',
  '../agent-task-store.ts': '8cc853ff5e8de8bb8149f966bd6d5f2f55032b16365e9f52f5436e9f36a2bcbe',
  '../agent-task-service.ts': '226f42689d54ad511770c22cc62cfdfcad65673e7f5d2850793a043c73f69dc7',
  '../agent-task-router.ts': 'a9569317a35a7e20070f358023d32230d2dbaa00e22534afa3750e0e66cf4f98',
  '../agent-task-runtime.ts': '3cb0fcf9ba3f11a69b6ea0897d2c6d6c3a834038ea4a1ebb3dfead933a36350c',
  '../../packages/protocol/src/agent-tasks.ts':
    '41388daf112e457878580cfc9235d7aedaf202b17f78938a0841982ecee1b968',
  '../session-collaboration-router.ts':
    '9942aad799316c357c2673096f3a8f0e1c61ae510a71ec51a10d462abaa4be5b',
  '../../packages/protocol/src/session-collaboration.ts':
    'e8e47f2b79832f0288063745acbed93c7c5f8f4db71f5c8a71705b1b02a59198',
  '../../packages/protocol/src/session-collaboration-store.ts':
    '7361e3e2ad32247ae6eecd12dfe68b2b7b27590cc95d5c46729b503de94bb62c',
  '../../frontend/src/pages/MockupsView.tsx':
    'fd7891f65bc8f64fd04d63c222425166e1bc05c5cffc69b67f035ddc36ba33f7',
  '../../frontend/src/pages/MockupsView.css':
    '4d1243a3087286f71bbf5b5ab7b1893335266891ba1d6c0cf5f62dea4580aadd',
  '../../frontend/src/lib/mockup-catalog.ts':
    '62a1d6124bda33a1b1a67d4b1910fadb6b04b9cfe7fe678df29c17bb62466b44',
  '../../frontend/src/components/MockupCollection.tsx':
    'a0b9050f26cb194e95e5d3ce0726840221b2dccb9899c5b4ff616d047d85a8c3',
  '../../frontend/src/components/MockupCollection.css':
    '33b7052d3643d7a104f99d2ef3b8eb33a51f0209af471218e1bbd4d89d6ce819',
  '../html-preview-shell.ts': 'e22ca8e8245db06a3e55e17971b5a0c1f890b1f89cd5cc88958a94b180c3e3ff',
  '../security-headers.ts': '1d9f242529d764439353e492ffac07929788455546a68156acf5d4bf852b1534',
  '../../frontend/src/components/HtmlPreview.tsx':
    '70bf4d8caab41e76d245f9763014f164b027ba35603176a38f9482db533cb93b',
  '../../frontend/src/lib/api-base-url.ts':
    '68b440dacf7db8f1afee47cce7fd463002f1bd14e7e4b3f6e391143a9e466f7c',
  '../../packages/protocol/src/client-capabilities.ts':
    '8dd04e33daf77b98951f93a1e377e79a671a5f9303585c847d01ae895fd9bd95',
  '../telos-item-store.ts': '71e0414e15d24cf8c2856c14a739037024ba1657f2481dd2ede9634a25eee7f5',
  '../telos-item-routes.ts': 'b600aaad3c66f6221d526c6a16d11d61d99f761e640f4cc4d9c14bef84b12789',
  '../telos-item-tools.ts': '6338abf7d20c0a7ee4f68de4c85e49a75acb8a76545822fba14246d86efe6abf',
  '../telos-mcp-server.ts': '1f92e4f921a3a9af617e878c3460f5d82eaeb533158d9b7bfc4bc9b0028ed4ef',
  '../../packages/harness/src/tool-tiers.ts':
    '1fb84cac3134140f0feff49372de63453e179488d7c88eb14a4e30ac4eb41acd',
  '../../frontend/src/components/ChatWelcome.tsx':
    'be4dd3a9269459ddbfeeab8daa3b55c3fdc12bad84f12446a4dece772036ae5f',
  '../../frontend/src/components/CompactionMarker.tsx':
    '46cdcf5b79952216b2a134a47a1605d7e9c7872377dab8505779366f6955c173',
  '../../frontend/src/components/SessionResourcesDialog.tsx':
    'b9aab7e260578927a0582296440038fcb9b7a9d14a847c11559ac1dcf2bfb3a3',
  '../../frontend/src/components/SessionAccess.tsx':
    'ea432fe32be3cd61aedc2d4fd8035950e2a3f0eda949733356b22512b9d9db33',
  '../../frontend/src/components/SessionBanner.tsx':
    '1c53c85a30dfb1898ab1d29edc9a40652c1fe7f6a2d52f4a74dad702b8854060',
  '../../frontend/src/components/TokenBar.tsx':
    '25c80275d287086e2e893a12634435470b38358cc17969d4905e1b4bddcdf354',
  '../../frontend/src/components/ChatArea.tsx':
    'c7ef551a9d8e3d5598b80573f806eb588137e29e47f23bf1894b7e73602a252f',
  '../../frontend/src/components/SlashPicker.tsx':
    'f4df78552197d0add98192e11e6d1014f9067c9686837132d954989c4a31bac3',
  '../../frontend/src/hooks/useCompactionHistory.ts':
    'ff7eca395fa6f00f1eafdc923f6a30d0534ca9dffb6d3e6f2a51a3d559e61f6b',
  '../../frontend/src/lib/session-resources.ts':
    'f7b341a60ea6a27017f065a6bb852bf279e8d69be72b66d5d6c9a96f18773afa',
  '../../frontend/src/lib/composer-command.ts':
    '32437a1cfec0294f41e36125456cc0319f2baf63ed5b0369f048556345b735ae',
  '../../frontend/src/lib/compaction-presentation.ts':
    '55f00e4c70eb1595614cbb4c57178f15aa96e18b7ce53ee38748068208f322c1',
  '../../frontend/src/lib/waterfall.ts':
    '1147ff7a54279264c4573fb85baeb3d4cff826974f36794d0f28ca13113f2575',
  '../../packages/protocol/src/context-compaction.ts':
    '7e616eb57676b49caaaf6f70b41c59aa3dbc4e11ce475d796714f694cc12291d',
  '../compaction-history.ts': '404dff36f9f1f57d8d7124e876ccba8c315e2989041a096eb440ed69f1e0534e',
  '../web-search-errors.ts': '059b6e418ef97abe994ad92fd37302844ecf11f0dc05e861569be21a49d0f022',
  '../symposium-host-tool-bus.py':
    '0a214810f54fd435ffb56adf80f917062c60e3cdf334f88e5aaf429c1f6eb44c',
  '../symposium-host-tool-mcp.py':
    '2cb79bc6ae7f3f02fa0156100c3cbc74524a0523279d873d1851d085a6b19cb5',
  '../web-page-content.ts': '348452aa0875f774d67f8b3b9f65bc793683e0295123e2c63fbb6011e1fbe67c',
  '../request-web-access.ts': '7c3827a0e4ddaf8880b6ec02e1af8bc398b4b064a90bf941570751b859e467af',
  '../web-search-adapters.ts': '37048de3d44f2f3017aab3006c7e2abaf5c6b1c3dda1a624dac9ef9e9b8deb35',
  '../../packages/harness/src/index.ts':
    'de051e9e9d34220808832a08b598e010c9d0259d0ae4fd07764a1b0406da88eb',
  '../../packages/harness/src/session-transport.ts':
    '7aaab4c6a3fb5f362b000e7127a8876fb385928d6786145f974ea8ecd4ce283f',
  '../../frontend/src/components/SymposiumConversation.tsx':
    '786352592c7944b22fa9d9e402df18c7cc6aa09984718b9dd90b64af86136608',
  '../../frontend/src/components/SymposiumReviewPanel.tsx':
    '32be2e13877a0db2e2d8531718b9410138471c01cebc963592df3ed69cdf710a',
  '../owned-local-codex-control.ts':
    '5691cd514b8dc92af077dad4a4b6bca23a65fbec4f1cb67ebf6748af67e631d1',
  '../permissions.ts': 'c402e63e948be047adef546c858129aaf218168a41114dd4235d62a23da530ae',
  '../symposium-director-configuration.ts':
    '2fb41b14d1bf19af75f4b6a3dde81e65ad58e4aeab773612f8819b7d6b70c3ca',
  '../symposium-director-route-composition.ts':
    '6978b9c8ebbaaf7ae50a7086e096e94542654c40f2005d944651426226b9dabe',
  '../symposium-artifact-route-composition.ts':
    '8d9e87e2a2873f0dc841429a5b9a43b93aa194237e4f9594b572e87bff27142b',
  '../../frontend/src/styles/workspace-chat.css':
    '0a7db1ba687bb39d60fb3a53da94e8519b950780afb83018c9546fdc6234665c',
  '../../frontend/src/client-store.ts':
    'e678599c740e0d6c854913d24f769e0ad7e18058341e53e77e0e37479e1ff558',
  '../../frontend/src/components/AccountModelPicker.tsx':
    '9eceb83413e6ae50d00b1aaf4f3fd9547f3289a2ead0acae764df25c3de8c3e3',
  '../../frontend/src/components/ChatAgentProfilePicker.tsx':
    'eb2404843e95cae0369b118c36303a40cf04624e05eb60ce138491a14c936614',
  '../../frontend/src/components/ChatExecutionPicker.tsx':
    '09e817e4b6a0b2447c97f8dbad2b1aa9537d0b8958d87819dd5ca7600d219ff6',
  '../../frontend/src/lib/keyboard.ts':
    '1e4c48c258c5e1c73be9f9df03a0491499210b9c24baf2fc6d134de41a9c3008',
  '../../frontend/src/components/ChatInput.tsx':
    'afd229552db9115af479dc1d026ad006cf73d216dbbba20c43ef8bbf5d9d78c3',
  '../../frontend/src/components/ComposerTools.tsx':
    '932d2f492cb6f82d8bd5fe45223ac61386390774249e73c2d64b649a8419cd6a',
  '../../frontend/src/components/ContextPanel.tsx':
    'e64b65ff9dbb4e5d7e686f189f92c9105b18a8b8edf5433de772515c1d374107',
  '../../frontend/src/components/ResponsiveChatView.tsx':
    '780d533ac1b433098110e92f154bb94e45bd229c29fd874e3b807beb56247aa8',
  '../../frontend/src/components/OrdinaryCollaborationEntry.tsx':
    '23d4b7d10ec64b7e3e9daf19d81dd0951ed6c6d3d6602fb0b977e305cc535360',
  '../../frontend/src/components/HomeDialog.tsx':
    'fa28d9039091b61d5cd29647ce4b49fe35dfc23f447fd3eb96b147f12c6b7601',
  '../../frontend/src/components/SessionTray.tsx':
    'fb925d5d5e01d29a29fefcac96fcd3913eb6a45130cf5b910a590116d45e5e1a',
  '../../frontend/src/components/WorkspaceControls.tsx':
    'f439a002496c7999033e27fd9374eecb094f35c8077da00d60936528dffed17a',
  '../../frontend/src/hooks/ChatRuntimeDraftProvider.tsx':
    'fcebbeefa5ff14bd074515519a0c4e1d6774ecd7177921ca2264328239cc9720',
  '../../frontend/src/hooks/chat-runtime-draft-context.ts':
    '32660ff240dd5f62c2a8ab976941553a84b7f3809ed3455ffe4e64ccfcd2613d',
  '../../frontend/src/hooks/useExplicitLocalChat.ts':
    'd416d417cb2d4774a3383e6e9bc0dd3019f2e154b827dfd3086d5d82799c78cf',
  '../../frontend/src/hooks/useNewChatDraft.ts':
    '4791a0f7870378d7353134e2a93972f1f7b5ef8197f20cfdc7304d0fd8adfb75',
  '../../frontend/src/lib/launch-draft-delivery.ts':
    '88b02b396b8222b978d6307ea7a0470123c799c46b3e0e48e9f017fc1bf72b4a',
  '../../frontend/src/hooks/useDraft.ts':
    '6b1e52a2e59745e2976d4a639d4c3a0b7f03bfcd95832809e0ff1665eaaf66f1',
  '../../frontend/src/hooks/usePendingLaunch.ts':
    '50d02ac129734f1944e464361413f85afc6ef0fbcbc1ab232de9a7e7a513f779',
  '../../frontend/src/hooks/useStageChatLaunch.ts':
    '607b783bd86d52b78df4e814a13df8f1c0c212c6df34a69026379ebee715bc72',
  '../../frontend/src/hooks/useBriefingChat.ts':
    'd0b124d3acf747c6a2605cdf23a7a0bfa59fc87d2aed1d3cd230e440d2c69996',
  '../../frontend/src/lib/chat-drafts.ts':
    '213d48b45026e86a57ae5c07727c8f086099e2e1ab292aebf7cf6dc2eb9928df',
  '../../frontend/src/lib/chat-runtime-selection.ts':
    'b47f7b6cc1bd0d261c7c57560204a1e5d18edd72f58e34e7e9fd63eba1244de0',
  '../../frontend/src/lib/explicit-local-chat.ts':
    '2e68873e8331caf74cbd1ac0acbc9268c263e4e1efc96174979cfc43ef51739f',
  '../../frontend/src/lib/reviewed-outbox-storage.ts':
    '89c3593476f8ee0e99ab1ad1f8b0879626e731a8581cf755f5090624cb8ceedd',
  '../../frontend/src/pages/ChatView.tsx':
    'ff01617577cce3533995201881ca19dfe8c53f71927ccaa7c88d3d8144f5610f',
  '../../frontend/src/pages/DesktopChatView.tsx':
    '1f0887e46cda5e5e2b51c82ddfeba04df3a4e845a7aaacbd676e5b708b25d1a5',
  '../../frontend/src/types/workspace.ts':
    'c54ac596082365496ebf53ca12ce1602b792acfd09092a216285aa69dd38c162',
  '../../packages/client/src/send-outbox.ts':
    'cc6601ea07ccc4398835154261424b9cda6a631d28d36adc283261644486a963',
  '../../packages/protocol/src/local-codex-first-command.ts':
    'b7dd2d112112aeadabc51d968397e5ddb1806f8130e6207ded0394a863d39865',
  '../ordinary-local-codex-entry.ts':
    'c7accc3efc53e64874c79c03217ba8bf356834d4477b6c98a38d85923a95e411',
  '../ordinary-local-codex-metadata.ts':
    '0ccfe315aa4bd8b5360608a3a588c3c0545c3fb7a34b3673c9db0156c610283a',
  '../ordinary-repository-startup.ts':
    '34b441c08703c9239c0f247aea72fc8a759181780006899056cda7e8f51cf608',
  '../session-profile-tools.ts': '2eb02dd87c257f53fa98ea63a998087cf5baca51e77cfea8a935c1900d05da1a',
  '../symposium-profile-proposals.ts':
    '9d9501adf2d17db1c5b6ee2fe85d308e283e46f920a12b34e95e08eb61e05968',
  '../symposium-profile-tool.ts':
    '62f0b42ba7563982c7c88607e557eda7983d09be9a69baee7da45fc822eb02ac',
  '../symposium-profile-proposal-routes.ts':
    '1364bd2a427322a09682d0f51193dda4d40a0ef7f19970e7ae1ff6a0cac70911',
  '../../packages/protocol/src/profile-builder.ts':
    '1f8ac1d7212bff420527b3d51edf4b9b060b08fb4c82280ca6184a4ec6bfe282',
  '../../packages/protocol/src/context-injection.ts':
    'f374381a452c3a5354d9b4e84b21ad3d6d40d10879e43124dec30f40118f60bb',
  '../../packages/protocol/src/ordinary-local-admission.ts':
    '228b21ae3444a968754f20398cfd7e35db19b60798b2fc678d19efdea281f60e',
  '../send-command.ts': '34845f9e699ef77c245bef3eda73213766c0de962ff75239ee9fccc67f095c22',
  '../ordinary-local-codex-admission.ts':
    '3da38714906a41597037c57cad038fcc51d8187398c02aedd68bb1d076975384',
  '../ordinary-local-codex-capabilities.ts':
    'bea6fe896ae2956aca4d8b7ec62077ef2d35d0753a94ca78e888a721a26815ea',
  '../ordinary-local-codex-host-runtime.ts':
    '5b152f654f029ad43dc1ded3808ea9fe2765b02c753b3a4a414867cbb37e078a',
  '../ordinary-local-codex-selection-owner.ts':
    '2cbc9994f11738234789a56cac5143254e7d08b819fba217e12e15dc3b79b9e3',
  '../ordinary-local-codex-owned-runtime.ts':
    '56935fc386d88f4871431423e073a2100175b648aa0badc44dfb69ea234be709',
  '../frozen-host-codex-login.ts':
    'eba897dd3a1d86f6e2567d737980fb74a963a610aade76862222542bd2f81805',
  '../frozen-host-codex-executable.ts':
    '4df86cc1b77d7b4186f9c285bc77fbe1127d16142501d78cf45ea77d628be96f',
  '../frozen-host-codex-bootstrap.ts':
    '81a47639a36d390b3daea6387138d7915408ed60f80df286b27ca9d60b0d48b0',
  '../owned-codex-lifecycle-bridge.ts':
    '784da43bccb37c0ec044ddddfebf547c6d72f94737e32b35378ac761376d0f1c',
  '../owned-local-codex-chat-admission.ts':
    '8f610e04aed917d7d41f550344bb2837e7c77959a0e973fb01858a00297e06e4',
  '../codex-account.ts': 'dc2ac5efec915495b6af3c7a3001ea4856427ca2d185648a864d2ceeb6593e71',
  '../codex-runtime-policy.ts': '478f9dc62e9100f01a0fdfbef207cdd02453a4a9a596039e84d70dd94ea85b2b',
  '../model-catalog.ts': 'e6922550fed2f7d6d3330299dfe83726d97d126e79c4a3abdb5e3334020ce90a',
  '../bounded-file-read.ts': '8332b3e5908ebe1464eeb7c99a8963bc402ae1f2d89a979a7495f53d54914070',
  '../session-permission-revision.ts':
    'cf71bb38e2008352cbccfd22aae88f747625a3533c26aad22537d9509c11a26a',
  '../auth.ts': '87920c89768d613ce00f84bf20ab405d95e139d96a168595e7a8c6431d80e963',
  '../native-file-operation.ts': '0bdd92a554e86f5adc56f3607ba053eca7de22281343f97a9e6cc5e6c046f1cc',
  '../sandboxed-command.ts': 'bd8a52ed4a6ad7e8675b345647f111c7dbb1fde5cb6482d4d8dabf6b445622cd',
  '../../packages/client/src/sse-connection.ts':
    '03fef53de70e3594cb948ac6ecbfe010979043411c658446eb5e2217911a38ce',
  '../../packages/client/src/store.ts':
    '306c66c168775fccf60a44889fa7d1d79ea1cbf6ff81ede22b69889494aee178',
  '../../packages/harness/src/permission-handler.ts':
    '78c076abbede0240b4695b4dc93a4fd14c02b8ee65fa8788fecd42d74f27dbc4',
  '../../packages/harness/src/permissions.ts':
    '546e88401d53f36462c338ec4ac4b4fe86e257cdc39e4f9af44b04989fa05733',
  '../../packages/protocol/src/session-approval-scope.ts':
    'ba694fed805637520dfbfdb160f5d8ba8093a76d1cafe70709dbf18a443423d2',
  '../codex-app-server-client.ts':
    '02068ca656f91ff525bdec2b1ca25c1e5733e929b8b66c821ec98b3d0643a766',
  '../codex-mcp-tools.ts': 'ad82004d216382a911fbc1f089e4aeb8b22b2e833d6ced51fa6c37682a901206',
  '../codex-runtime-diagnostics.ts':
    '00b48e32557feff7923a5d548f085d2107383491689ec43f75f465287552f4c9',
  'capabilities/approval.ts': '25c074b3091e67b0c3faba822e8e2c00ff32a34416fe0b37cb4f202d040d0320',
  'capabilities/types.ts': '2d87b1836d4040bb8a887c17d89cc3ccfab213016e6d276cbb3cdc084a0b9a89',
  '../notification-center.ts': '8ef1492ed0a57a99aa7d51fa3b13d04a39e0d220d06913b58559494e921cb36b',
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
  '../url-access-tool.ts': '045e01d27a5c5428b9430e440916875a622ea8eb90f598c577d22a2da680a457',
  '../web-access-tool.ts': '0c5e1a8a589cc660983f814abd1994b6b877b1bd1f02b6bc8c26521f6ae1ba13',
  '../index.ts': 'afc7f047cf9ef186f69dd0311eac861d3020a47260b9b475f271f5fea21601f0',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',
  '../chat-rest-handler.ts': '3e511081210d3ccd59755d28eb9a4d74c91bdac8a4c21a2dd3882080f89e072e',
  '../query-loop.ts': 'c4b8d036dfd418981cb6e4643143d6b4928645e529ba1bf79fdaaf3840df698c',
  '../account-profiles.ts': 'e8b8e659ba11b9d3d28abbb47542929d103dde5c1f2f347d1b6361c547cec759',
  '../ordinary-turn-lifecycle.ts':
    'a138e83ba1a2ec8ceaef967858fb926d5de83658d21f555f32c98174afd4064b',
  '../ordinary-contributor-guidance.ts':
    'e3f6ab23f20cb58b8065f25471b71b55580af45e107f5ce81d91fad37c4d3ccd',
  '../ordinary-contributor-execution.ts':
    '64c85d35d19b57b4fee7ae3dc8ff6441a666efbfa36237b0a4b9f6ca63b613a9',
  '../symposium-dispatch-boundary.ts':
    'fdccd76d0537d9edf665eddbbf0d2fdb32dddbbe5bf423498e21ff04606e9dc8',
  '../symposium-seat-runtime.ts':
    'b5584fc1387894ecb9658bca82b07ec38460577770dda51f7b8dadf13d7114a4',
  '../symposium-host-grants.ts': '86a4a2735f619987d517a512555b3d6fb912915ab7fcf342f2bee18beb418f48',
  '../symposium-shared-execution.ts':
    'b884e6783d170bde0570d9ab645b13a69a3ab531a77ad12534bfb2160a609551',
  '../symposium-ordinary-turn.ts':
    '80220a38e332849d1ef1c37064e0342b52fe1c901f4d0792a5ec73b9e304ee06',
  '../ordinary-codex-contributor-admission.ts':
    '20b50e35d894f942181af17b0e1bfe8a1fba059d3562338e586ee68de16841ce',
  '../output-contributors.ts': '43590c62adfb9814031b739e44ed0e5c05230242e0cc7175bc204d6397a5f6b8',
  '../output-contributor-routes.ts':
    'e8b9ffc353713edbe91f9be431422996b142e91716147ca915e6f7702e94c1e8',
  '../session-output-references.ts':
    'f3cc6ec16ec1c2dc907566658c3f12b1776ee35f1bde662a77e97b9a08946841',
  '../session-output-routes.ts': '2e08e938b4914797006231d1044b2c6c28693aa7fe1813a37d6ba1c9697649b2',
  '../../packages/protocol/src/session-output-reference.ts':
    'c103af10de4adc81cdc474b3e69ef2b3de5e447d4dcf15da4fc1894c422b913b',
  '../../packages/protocol/src/session-output-reference-store.ts':
    'de139a8dae52cc0294f50e13fdb96d0666c81e376e282e84c640a0b187dc3014',
  '../chat.ts': '2e6ff8df3943b3ae7adac4fe08f7b23f141fdf03402c9f9ec93901b5e9a4a408',
  '../../packages/harness/src/session-registry.ts':
    'ca7bfe6f28eed1432a26fa1cb32e72664b66915b7918aad1a363b303dd9a1c8c',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    'f254cadb334bc75dbb19104fdb7ed2b3e46bf2856b81d29300fd4f45db02674e',
  '../../packages/protocol/src/runtime-readiness.ts':
    '6be98645eb9b4467c30f5dacb3e8eee7a9c3f08cb6fc820edc872f789ef217c8',
  '../runtime-readiness.ts': 'ea27d8706c0ae6594b78b22436060eded2848b0cd9713e42fa51597928be3766',
  '../session-access.ts': 'feeeea5ffcf16bb1c4542191a74d5eebde2ea2dbcac7cf0e5315d05e2249b1dc',
  '../app.ts': '6b4d48ed8c3c6968dd2798c2ac476bea4a9a86a5e364a3eb99ca7064fea86e6f',
  '../auth-check-tracing.ts': '067dc344d8ee76ffe39739a99076f614711ca3d11f96682c842c596a7bbd112e',
  '../telemetry-relay.ts': '302bf6cec2b988ae71a123a5dd04d0f2266a82c3ee51873ec64d8be452c25427',
  '../symposium-review-route-composition.ts':
    'bc2cb2a85517a1f16279fd87757a97b9bb46a16d9efc5f15b52bf41a6f14cae3',
  '../symposium-review-host-contract.ts':
    'bd41408c8dfb9fe4a239fca2e35cf8366bc379e63c4a310d3593cf709a1920d3',
  '../symposium-production-review-composition.ts':
    '5d0e4d78e45cc6d9b3c601cc1f5587c469432bb3ec9edc0c70fb34153dedfc5e',
  '../ws-handler-v2.ts': 'c86721523b5875cf3b3f18642225df8657b30f2e2574c8a0835a1f5fa5255ea2',
  '../briefings.ts': '277b26171abc42266a3b621ff7ab10306792764cb55bbc635e41c4ba20e98d49',
  '../home-router.ts': '744708f3503d3ef46114998ce9bb6a68b3068a3c7d57e0c264298cdb69aac982',
  '../notification-store.ts': 'f6b5ec6927c367a94511f6eaf215498ffdb7e76020f417105df81d3812de94f3',
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
  '../codex-conversation.ts': '0b5f98a637a923788ec8188aab0e2cab14934386592a4bc99bab52a138ab059a',
  '../codex-conversation-store.ts':
    '17cd78aba4daf4da22f952b5b4c6717804ca0004842f5942cb482819ef51da23',
  '../symposium-custodian-ipc.ts':
    '8dcbf6aefbf29742b2828b7e8ca657aa294e8ee9601f52422ada469fac1731cc',
  '../symposium-custodian-authority.ts':
    '5ef9405e845e24f9d19af0820deac42d3404dbd5fb86d4f09f814e45226edd6b',
  '../symposium-custodian-controller.ts':
    'badecc7f7233eed75026a896d04058b8fdf4821ade2e0a042cb74c0a2ec8bbf9',
  '../symposium-custodian-http.ts':
    '5f829b51dde43d1c7615c572ac73b2745c676de0f4f9c39dfd5a2704adc83850',
  '../agent-library-adviser.ts': '55df1630714da3195653087beec4744af6e3042ec79f73760fa33288ae47ff98',
  '../terminal-adviser.ts': 'cd67017b760d81455fa8bf272b169d649b93c898d0da05552a92ba39f80f5529',
  '../terminal-adviser-model.ts':
    '72454799fe02a92a5c4c2d8bbe36b16f4b7df6738a25e228f11f3d521e1b067f',
  '../../frontend/src/components/AgentCreationAdvisor.tsx':
    '872b88cbc121b4627be5078f2b73ed079b0a72dec3a1c41c3dcc2e44fc8c4a3f',
  '../../frontend/src/pages/AgentLibrary.tsx':
    'e71c544e721388bcd86fc539d35ebd1ea243d1ee37e30edc113626dd66f382f6',
  '../../frontend/src/components/ToolLibraryCatalog.tsx':
    '3bd309c607946c2a4f47157a4aed52c2320f6b0bc773c63b27630fa72db78b76',
  '../../frontend/src/styles/tool-library.css':
    '23c76aa73788e21c161004a3b06a2b413b909a6d03c277a24817f04ea45e0c7d',
  '../../frontend/src/styles/agent-library.css':
    '693c8477ad3e0c01bbab01d1054d3993475caa8b6b21b526e481d2f00ad6bdcd',
  '../symposium-director-routes.ts':
    '71fa6b5d798815b452b26f7df5c58733abb793222bfa21ec71926b8bba2d8e74',
  '../agent-library-binding.ts': 'e917cecf1c86505c8c420590b2e38e10fb2c8808449f70055e979f9588dc5c87',
  '../agent-library-transport.ts':
    'f532d75cf524bbe6f2e499ccdb045c2e84dca83ed44c6606b8a70fe4d3c7f3a3',
  '../agent-library-store.ts': 'fac60510d3a4b45aa34777daf885142e067538726104c749f4ebe533861472c7',
  '../agent-library-router.ts': '7905a02837dce7008992136f07b5e92aaec1818ff787e345f4f9febeaa56f520',
  '../agent-library-runtime.ts': '88d4762a00dbeaf1c7abd4bea23a8c9db612c755eea32b8173ede4090e6a4fe6',
  '../agent-library-prompt.ts': '3be39c6cd2fb12c744c5f53e45b8c8b306398146edfcb2af479d4fa1c9159c28',
  '../symposium-profile-portability.ts':
    'aadefe0eab442dc27ce68b86654291299dc6664a185b903af44756f79ff26680',
  '../symposium-profiles.ts': '4138fce2cc44220fa90b3ef65b207b89c06a5f02cd24750a748f79d84d297c95',
  '../symposium-custodian-protocol.ts':
    '279efae6e666701b493841881c5e6235594580581db767b57bea8d9a7bd3f839',
  '../symposium-custodian-proxy.ts':
    '54b6f034f4f9bbdded5da4d001e23da676e7b3f4f816da9b346e2e61d66350d4',
  '../../packages/protocol/src/agent-library.ts':
    'c9c5fadf380fc72edc81ec7b762d1f69620d06dff5ca40a949568ee61a2a068c',
  '../../packages/protocol/src/symposium.ts':
    '129fd172bc38c895e31d0835adf799933ef7641a200c33a3b8135a2e318b848a',
  '../repository-chat-tools.ts': '74e686017b043f61e063258aadec9387f2141e5f5a94238bfdcd6780b3006a77',
  '../repository-task-copy.ts': 'cd15f77cfa45883556d10536296a28f7451d2259a5a3eb2a9aeb807d24c54d6d',
  '../credential-connection-schema.ts':
    '3489ff131cd0bc28de23d85e1ed7cd4749fcb12f062bdc76407bedc0efe28f47',
  '../credential-verification-error.ts':
    'd4fefb2652ec0bd00b24aac257b31a028b597dc20dd7101c77d527fe4505973d',
  '../credential-setup.ts': '8dfd54d1b4cb4408d52c9ca09f5cc220ba69adf6dc6181bc7de6803fee38f69c',
  '../connection-guide.ts': '5c8c08b94ceb0590a1513830dc39874d8d9b7328882392b56f5ee866fad57c25',
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
    '191f5791ca2eaa35e7e0c427d971b830c62663a8f347662758f84c5b538f507c',
  '../credential-connections-router.ts':
    '6d7b779ff5ba148b6aea43483f4003da0d9ed4908e551a273de5906140c7b96b',
  '../credential-connection-tools.ts':
    '209dca272473d84f5de0f63e2bfae6886ef92121397c4352e443c2f2aecb2730',
  '../credential-connections-runtime.ts':
    '89a1cdf4bd50c73a0aecfb966303fb37e0f524da9fb977478602c9c198a51b4d',
  '../credential-http.ts': 'ad803bdedddd64babd20711b076ac9b1e51cf7215136c1a04f6519d1c0e6e748',
  '../credential-redaction.ts': '817dda948c419deb064bc4c5298e034e5a0343972b4bf724fb6aaa869cf34403',
  '../credential-sdk-tools.ts': '4ebaf013d5b5872175155d26e2b7df76224d086258f7bd0d8eaba04af793d2a2',
  '../session-credential-tools.ts':
    'ecba84fc3bbc5aa7acdae93979dbc98c058e71d492def42c4f7c5a7664b29ece',
  'policy-compiler.ts': '59579f9eb69a3129dd2d8e1676fa46bd21da45c07f58752183416c82c0986014',
  'registry.ts': '431c78947dfcca432ece96d0d708f790705484443b9bbdf78c2edbbebc4a4216',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  'capabilities/github-publish-pr.ts':
    '40e45185db8ba26c3e43c3b81b783c3d877ace75510140602a43a9a6a56c1ff2',
  'capabilities/github-publish-pr-transport.ts':
    '434d2c56164bc372b9168fba26acb806f509a759eb2f8c24ba8eaff5c8c9f5f8',
  '../github-host-source.ts': '2720dd0fedf081780ebd64a485164ec5abc6dee7920de925d35e3e6aa647e084',
  '../github-publishing-tool.ts':
    '41d7b35a2306efb9709b53e08deae3971c549101e46d92dd604390018f19c82f',
  '../capability-conversation-binding.ts':
    '147a328d161f167aeeb31bf0017d5fea25cc3f22933392249a228d7bd61e89aa',
  '../openai-key-management.ts': '3f9217677809a041042a598434aaec619a636f3e0b6fb15aa46953480c11b667',
  '../openai-key-operation-store.ts':
    '53aa481b64f0b7cbb6055d3d0bd569bb4dc4cd55cf6807748e99a63cc66f20ed',
  '../openai-enrollment-models.ts':
    '11a318042fbd8f7aecc09563c80456bfff424813a3d12a05d01bc768a0358263',
  '../openai-account-enrollment.ts':
    'ade50acdf50e214b62f2c4068565995c1b949d18f96533e0d1d081ab83f4dfe0',
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
  '../connections-router.ts': 'afb2657c850dd4b3a64cd2d295ca8682204ddcdff0dba90ce6fa610c15596e93',
  '../connections-service.ts': '930b9fea2c31e82edbe16ab1cab670e338cbe4403f621ac7c6e744869fb9c905',
  '../git-branch.ts': '6dd4fef0069e65d78fc94d047777442e4ef073596555581da536e1e39a5d3877',
  '../github-repository-source.ts':
    'b9a6ef89472b001cb8cd8f8bc04c3b31d514980d9a5154cd6ad48c5b30d42c09',
  '../worktree.ts': 'e3fd6d93d33cb5403786c5a7da16dd229d8ba03ad06e8c3abaf6309c64adb34a',
  '../repository-task-checkout.ts':
    '32fd232781b0ba9573fa0e6a511a78ede54a8c33a80dee30f52d06283b4beab5',
  '../workspace-runtime-private-paths.ts':
    '5839c75aa2e5d325218af40547c28395ec92a56205fd50a023497330aa44811c',
  '../codex-private-path.ts': 'a42946b67c811a916df26adf760ec8b7b8551123fa724edf8fb4a5ff6f866b43',
  '../workspace-runtime-client.ts':
    'eb377ad70361797cb34de00c1974952b76cd81041da7668631b138cf5d44473f',
  '../credential-sdk-boundary.ts':
    'a0b2ed52adda81a5ad99ea5544829862df2dd0716ceb5f57d8d3d43512833e46',
  '../sandboxed-command-worker.ts':
    'f2cffea266ca292c2ba690725820e2c23d4a90fc3ed61619540a960bbfe72f23',
  '../protected-sdk-command.ts': 'e7c59a2ebfd3fde4b0c7c8cdf7f69f9d231e2e5f1819a61e0514cd707bc6c32f',
  '../native-hooks.ts': '4c29712dd8c80db92f6872815848aac37858a4d59b8861700aefc8c8c97e185a',
  '../hook-bridge.ts': '8885c2b27079799d33958a17942bb7d8953d01540bf7cd4b3ade537ee39c2d12',
  '../native-tool-executor.ts': '95799f43eed7d0f818bcbb1cf9cc504d99168bc31877f4f17a19ae9fd0539d13',
  '../repository-workspaces.ts': '8c8a55acd1d84d0e04dd1cf20191504e5f7045f710a79185603410bfce309ad9',
  '../../packages/protocol/src/session-metadata-store.ts':
    'fe9caaac077de634f0e76e8c203323a8075461815d973cbf5c431347f7844c09',
  '../../packages/protocol/src/event-store.ts':
    '03a7beb71dfbc0034fba29ffdc6a58d7d8bfe9b04cb036d45d8694d48e88577a',
  '../../packages/protocol/src/session-lifecycle-store.ts':
    '2a219b360a5fbe72b0a550c714bf76a15c6f5969cbbe4251671050257b98e267',
  '../../packages/protocol/src/conversation-replay-store.ts':
    '60ca279c37909d56d842535093f8d8186057a668a1b03a8e53c41f92061da32a',
  '../../packages/protocol/src/execution-ledger.ts':
    'f30d210be1d37f4c61ff47edb1fb3c8dea1dc6fd8d3ea02b6e01310e8d44ffc4',
  '../../packages/protocol/src/session-runtime-binding.ts':
    '074c03124322359a02795c7865a718205f80f8aa9fc6b4e0b5a8f43746d6ca4d',
  '../../packages/protocol/src/types.ts':
    'c431dcf57377fc97ed38af3be33bee555cd4934bd9d250ee54ff285c9272f177',
  '../repository-workspace-runtime.ts':
    '07392283170a840b2deb9bea390d2205295192609ee0d45048a6d314ead2e9cf',
  '../repository-workspace-router.ts':
    'bf65668f4b3a782216eefbbc097fe8888aaf6b73b0cdcf9427c3feb104ccc178',
  '../trusted-native-operation.ts':
    '81d1ea0c643053fb6a6f0b740b3767dc0cb2d7f4a1ee6739073923776ba5f918',
  '../repository-chat-startup.ts':
    'da5476aa7e43badb1809a8f52d958d5338ec921c6ab96531978f750fecf4428f',
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    '9733d55cd1cb15dcf68dd844fd85861bf4fece6f3d46e1926ec9c416dd59d7f2',
  '../task-runtime-guidance.ts': '6e308de61b1579d0cb47a1873b5723c1dda792d8284fcc5abf10752544eb7fec',
  '../knowledge-view.ts': '0582477ca1248067b1c10a97509f0a518343a8aa388f669d8297ef45e87b8559',
  '../openshell-runtime.ts': '3bb6af48164c23b647dffe9f26dcbbb80c7769f55ce7f57fb5a4d3e334752c24',
  '../codex-chat-session.ts': '1a77bae1206b5e282a37b17efa088e86ebbdc740d40376ebb71a306d7011bdd8',
  '../connections-runtime.ts': 'ef3a8ab39bad7cfb68c9cbcf11f1e62538f04962682463a4bbce4204baee4e6f',
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
  '../codex-approved-search.ts': '511b6ebe13277607afa9f3fd6990a100d828151962abb2623c65e4ef212d456b',
  '../native-codex-context-admission.ts':
    '91a021e0dba7a2e1d38cfe2a744da603370f562f5d78c25255237d4065eda558',
  '../symposium-host-tool-bridge.ts':
    '93559b7b6a5aeb1e66e633d2038cedd774d1a9efe1e8bbfc20d83c7e13326ba0',
  '../symposium-seat-authorization.ts':
    '26006d392e10e68c695e00039935332c28fb7146feaa057e482afa38c4f1fa21',
  '../../packages/client/src/protocol-parser.ts':
    'dee712d06e8e73aa02197c7e860447633c8a8f758544a8d56fa0ab62f31734d3',
  '../../packages/client/src/slices/messages.ts':
    '1c5ce65fccfdb2260d30a2d068dde7b280ed7f41669963efd6976d207a906d75',
  '../../packages/harness/src/providers/responses-session.ts':
    '8e2db677e8648488c25f50aa74604fd734b694f230ab137436481fb62aacaa74',
  '../../packages/harness/src/providers/session-types.ts':
    '53af4d3c4c3cb3d3e3179ca306689aad6faa03669d9ad62d652e21d18babf8b4',
  '../../packages/protocol/src/agent-context-pack.ts':
    '6964f27523d93a64c153f2d3a56650298a2063521abdafffa0c19c3dba839de5',
  '../../packages/protocol/src/index.ts':
    '58cf41036dd939d63ecf8c52751c4b2bb3aa671baaeeefb8b1c035b054542f5e',
  '../../packages/protocol/src/telos-work.ts':
    '7597f5477d2cf377474f6b0f08ee69b2c6045e1e7ba89911cd281b5d9f2b0043',
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
    '7ce6e23c73ef66fdec29fc1ca001e6ed308287096203423efd813a8e5406f340',
  '../responses-chat-session.ts':
    '45b14acb3913cbf138c41371818e23681a70cd073d35ec55dc8b57bac73d8dc3',
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
  '../telos-artifact-tools.ts': '66400ed107aaf030de5cfade45a87428d883e7a6897a7acd7ff8c959f3a16179',
  '../symposium-agent-context-authorization.ts':
    '497a2c4bbb4ca61892e392b11fe554bb88d5302921eef7305f88e74d03c206cc',
  '../../packages/protocol/src/ordinary-openshell-admission.ts':
    'd55a6266b2d5b4df95b9ab2e92526032de1ea6f080921f5adc4d182fced38f3f',
  '../host-codex-custody.ts': '684485006e92b26780a32b7f76d3bcd5086ab7492bc43508414d278278d4a9a3',
  '../interactive-auth-core.ts': 'c91026beae6b68449c50067ebaea0046fd0c551607719ec1c04b6e4ef5e5d114',
  '../openshell-codex-custody.ts':
    '879381e2a91161c01c257888cc6760203e505fc43f84ee9e9d84558ea60f695b',
  '../openshell-lifecycle-controller.ts':
    '288da46e547cd2fac452098e2ccfeb87da9a2e52f3993cf6367213d9c06c9dd7',
  '../ordinary-codex-continuation-status.ts':
    '047c367c317b24f64dd346d5deeb67360afa0fdefa3e2ae12e05f52382401a24',
  '../ordinary-openshell-codex-entry-owner.ts':
    'a23a14262a54b367755b3a6a9ba5b6213b988758e5122ffe29fcfbe7d4cc7c31',
  '../ordinary-openshell-codex-entry.ts':
    '2a560a7db7c4b1c7a06cea342f768acf00f46289a65784fc2ef96455615dc834',
  '../ordinary-openshell-codex-owned-runtime.ts':
    'e8da21226d10facc3a4b454fedc57e7d7a4de7cb608e7ca2d7a393dd2dfe4428',
  '../ordinary-openshell-codex-route.ts':
    'f0bfd42b4dd663d2577d77ca857fddb9a1ac67d6a894f440b08764b7b33191d2',
  '../owned-openshell-codex-chat-admission.ts':
    '00d4a4f86c3641f68e0a6d1b4ed0240168d350823bb7e88cb380e47dc612cf12',
  '../session-registry.ts': 'd91b89354926d0ec7355e73fcae4f41066008d63097ca00077f37022fc554ccf',
  '../approved-url-fetch.ts': '523bbd692e74a9c16b7fd851b6b4b1cdc6be5581e083c04f9549662e11548ee3',
  '../owned-codex-queue-control.ts':
    '00c6dbf8ada1f6da8b519600380470a1a42090e125877b79a6149fd7d9667e9c',
  '../public-web-fetch.ts': '781732b498e47ea120337d98ca96b9c127e78ea93dbb9e0ae6545a858ffe7dac',
  '../ordinary-codex-agent-context.ts':
    'fcf7bc0b5c5942913671ee9c0212b7122d0cdf769ce49806a1047f14158a841c',
  '../ordinary-codex-agent-profile.ts':
    '335473dc2705e699aa47ae63e7fc41836f32ee19f5f7609f58863e8156ffd924',
  '../native-responses-store.ts':
    '93018dd135459d6e273b9651aaa093ad984ac07c564e54198b6a50b74508f589',
  '../ordinary-local-responses-capabilities.ts':
    'cd24e1f31ced1015908efcd79066289f20f15760098f626403c036f077b3e390',
  '../ordinary-local-responses-owned-runtime.ts':
    'bde7b918dbbcb15243c7c47c382990bde49229fe10db36e4083e128458eb6d85',
  '../ordinary-local-responses-queue.ts':
    'd2c8999d608bc7ff76eb9ea113094df3a55c9bf861e6c5ad9f876531fda36fd4',
  '../ordinary-runtime-capability-composition.ts':
    'bab973501ae7cc341811d8271d31283e76f4026e1465c7ee79111a0cb47c799e',
  '../ordinary-local-vertex-sdk-authority.ts':
    'e0543f3bfa5fef364704228592d59173f7035730127c8b0a46f75ffaa4526487',
  '../ordinary-local-vertex-owned-runtime.ts':
    'bf39eee2e9f0591d5288a24639dfcfb3c9c56fc8ed5c3fb117b72cdcc1e518a4',
  '../ordinary-local-vertex-native-history.ts':
    'cf1078f41c2e9bc23831231b980f8202f2e615401867a9d90502c6d64191c22e',
  '../ordinary-local-vertex-custody.ts':
    '7f1ce782be5190881004a63aacf58d8df69acb0fe46d9bfe952c436cf6c2aed9',
  '../ordinary-local-vertex-entry.ts':
    'ce3cec966336fa454dedb1ab5d97c32fa3333c01b849f7705dfd2ca7c2ddc156',
  '../ordinary-local-vertex-sdk-query.ts':
    '12a0946c30d104539df468afb9429fad3b8faf7598bb0f30f15fe6d7ba0ee04a',
  '../ordinary-local-vertex-command-owner.ts':
    '7a631c564810af3198bde300697e5ed13c07e9185a85d10e1859c6678919fa5e',
  '../ordinary-local-vertex-capabilities.ts':
    '3b81465942f341640b55ea0f0e34625f1fbb50b36cb5c7abc617c1a751785cfd',
  '../ordinary-local-vertex-queue.ts':
    'a3cd6f4b1785ca8401c5c6e728e32ec531c6e0263aae9daff5643515912b59d1',
  '../ordinary-local-vertex-sdk-process.ts':
    'fb9323a7fe3a55d6998dd70e0b6e16ff5f008ecb763bc8da9777b7f24514a30e',
  '../../packages/protocol/src/ordinary-local-vertex-admission.ts':
    'cd3a4f1d1520ae11c4a2d8d840b8ec3efbc0faef57dee3f4bcd4dc9586188d8e',
  '../../packages/protocol/src/ordinary-local-vertex-custody.ts':
    'f118a9a47afcb9bf2683cffd631afb5b19bc230f1dbbb12d6309c1555f412c70',
  '../../packages/protocol/src/local-vertex-command.ts':
    '68c894b50473dff78d3c82ebab11d27b5f937a76a9b972248d1327b9e6b54d97',
  '../../frontend/src/lib/chat-runtime-route.ts':
    '96dc69ed1506d721fb39b7d935561fc96d8f335a1a944fe81b2ffbeb8fffd840',
  '../../frontend/src/components/ShareButton.tsx':
    '3f43fa3098cd0fd83b80bab6c42877ccfddeeef80b9ab0a8ec4e058240a94411',
  '../../frontend/src/components/CodexQueueStatus.tsx':
    '3cfcd679e62a78d6520813feefdb9c792643e822c75e7a32fa0b91ff04bdbbe3',
  '../ordinary-repository-preparation.ts':
    '2cf559fe9360a8d48e51413bf7f0d7a6b2d2bbfb89dc4675f595a2875216eed0',
  '../ordinary-repository-preparation-authority.ts':
    '54b65da2a861e974bd8846a12549460293ee6a4d7c585f1c7560976fb3d178fc',
  '../../frontend/src/components/RepositoryChatPicker.tsx':
    '9cda6bc42392508104fdf72971a8d9351a6f710130128c6b6e6146fe2033b172',
  '../../frontend/src/hooks/useRepositoryChatPreparation.ts':
    '21b62231f1f15b14e874be59d01bd23316f4b7ee516d514500d7599c7c653fde',
  '../../frontend/src/lib/repository-chat-preparation.ts':
    'd800d801ee8cd47bd102381a83e956b6d967db8480a8fa4e3cadc6f880d18786',
  '../ordinary-command-historical-ack.ts':
    '06fe3d509676e6d59a685b3ab89395a51751ad082b06ada02312a872b7aee7ed',
  '../../frontend/src/components/RepositoryChatPicker.css':
    '7153c59ed0581a3f69d46a3cd0a0a1f895340d7d6d34d2a360f5380b65f601b1',
  '../../frontend/src/components/AgentSettingsPicker.css':
    'bd30b16df165a784f34285058165f6e4cb6dd07839da21fe258be8410303d408',
  '../../frontend/src/components/AgentSettingsPicker.tsx':
    'bfccf9c31c9fe8f8893b885599634b6aa88dc99f41f8afe8d2d0e070fc5781f1',
  '../../frontend/src/components/UiIcon.tsx':
    '90b9c941eaa16cbc5a5b738c6bd653457e4ab5f69e1e0c4862ec9724d8d68898',
  '../../frontend/src/components/AttentionFeed.tsx':
    'a6439f91736fa6e604bf66638c7127cfcea256137a2ffc8284cf667772965bc4',
  '../../frontend/src/components/NotificationProvider.tsx':
    '5c8e900478b657b157119b52ae8f4325668a8bf96ace930f47de515a068f569f',
  '../../frontend/src/components/ProtectedRoute.tsx':
    '26e43aa23bf531d1a59408817019e9e43c6e12d6594a0bf6342ba63c4d494fd0',
  '../../frontend/src/components/TodoCard.tsx':
    'b325fd32ed13963c3b2f2b15c9b11e234ccaa561b512b09c6223598323e8cfc5',
  '../../frontend/src/hooks/useAttentionFeed.ts':
    '8f10be65de76cf721b6533c336428e3144c324cec9129a6b437b054b07cd1a22',
  '../../frontend/src/hooks/useCalendarData.ts':
    '0755998ba06d85a187eb248a9a9e34e925790c10c69b3905f6f7eb2e52e7f79a',
  '../../frontend/src/hooks/useOutputContributors.ts':
    '958852b928bc0f819c2badaada2a37fea725d81f0d1cc09c6bf64804b6b57f8d',
  '../../frontend/src/hooks/useServiceHealth.ts':
    '807a95678c49e8bdc2dd7d14979d0fd90a2e4364d51c34c2a859ecf0dfc81d4a',
  '../../frontend/src/hooks/useSessionList.ts':
    '8da1fb05d820785afec8e7ab671b10ed83b84c67ffff1317d5fd5ce677f2a4c7',
  '../../frontend/src/hooks/useTodoData.ts':
    '0792adfba908bde71c3e9e296a1610ec64060c81dcb76cece44973adfcabe4f6',
  '../../frontend/src/lib/api-fetch.ts':
    '711a0346069b965504c3140611dac64443ea82a6dc457d147e243a005b3eb46d',
  '../../frontend/src/lib/api-json-read.ts':
    '60c11f4263ea1e73478e4ff54542968d65c455b36ab9eb3dbb718d02abb94d18',
  '../../frontend/src/lib/auth-check-tracing.ts':
    '7ce7949ea77d373206b90e9cbe59254f4e76df03624eb7c2f0db2936ca79b012',
  '../../frontend/src/lib/biometric.ts':
    'e7689889b995006d0d5f99f757f481fdaf10f70822518d0c46f91c662d45a304',
  '../../packages/client/src/api-client.ts':
    '21d06e473edec895b0d3604567cfab12fcf3b79f5bc022827ef3cd174aa9b5b9',
  '../../packages/client/src/applied-delivery.ts':
    'ee75ecc60e14a6e034fc8486a830d542eb1de7ca7c2392df0eb9a3c2fb7d8e2a',
  '../../packages/client/src/applied-event-acks.ts':
    'cb9629e1da426916dbecd3bc0e924e45cf460799e94f1e49cbf7544abecf764d',
  '../../packages/harness/src/connection-registry.ts':
    'c592507070a0d30d6b16bab589383a274fe8c583fc3e542315dc528ba6706256',
  '../../packages/protocol/src/ws-schemas-v2.ts':
    'a44c078500d72ccec00da10c082dae5d5081c3cc1d54428ff61cd473e59cf565',
  '../auth-route-boundary.ts': '9b853baf795f6c65a7cf956311787d049c961291cf4817ad53ad9e22ec62dd4c',
  '../git-version.ts': '405110af784b38f664fa6165bc83da008aae9de92410395d22a031c6c6b4d220',
  '../logger-transport.ts': '835c336a641ceef7d2a5d368cd435aec33660c4b64f256055bea5dde671153d8',
  '../logger.ts': '7716ffb5d69ddf4307d7c7b45aa4fcde937f1ddb2c5af71f27f9706c54caf6c2',
  '../request-performance.ts': '0e12542fbd0b53f61fbf96b6ef26bddb1bf77962e50d4cb3325d7c81def56cd9',
  '../runtime-performance.ts': '617d0732c9bde4619be7ae36a2513e275c0a897bd354acf9459b8bd3e61c0810',
  '../telos-source-materials.ts':
    'c9ba03795ba968fe4726ce09ccd366bc6f9c7966277986c2a28580780c922111',
  '../../packages/protocol/src/markdown-paths.ts':
    'a3291190909cbbc5ae31390cecbd25106dc2edaacb5836d21c9f438c09b6edca',
  '../../frontend/src/lib/file-paths.ts':
    'dc6a94c8792ddee43d1acb0e635021fa66f2626e28e627f785ac7fbe13d198e3',
  '../mcp-launch-environment.ts':
    '97ac57133ca19edc39bc8b6ccf58bb4fdfab261ca71483d1c7ab937ffd03742a',
  '../mcp-config.ts': '6b7edecfee8c64bdd230338dc88f5ddd99e901098673d65bdb8e22ab6978171b',
  '../configured-tool-catalog.ts':
    '6d0b6b0dafd8930c1913a34451c2a1d515a49526ad91b9c0cc2b5ba43ae0bdbc',
  '../configured-tool-runtime.ts':
    '60b98526368eebc431ffe848bc51f88d98ac1dff1a4b5fda7938055677651133',
  '../configured-tool-admission.ts':
    'a0f869d7883f0bed0b8882b14d7569ee34b9e4316268813f3c6767721e86a7e7',
  '../../packages/protocol/src/ordinary-prepared-session.ts':
    '03967a378e99cf34906731b744d2717427132caea8f2d47dd1d4930faf34e97f',
  '../codex-ordinary-packet.ts': '30dab46fda1ff4daddccf2503bae33bacc3ab1f438c113a102c08854d9d0532a',
  '../collaboration-ordinary-delivery.ts':
    'bd5f853078019770871a660083177cd54e7dae8c7718f230fdd203ca39a942e7',
  '../collaboration-review-owner.ts':
    '43048f38b48cb2ca5cd007f129d640c13f966766060c1a45355dfa0bb099bde2',
  '../collaboration-joining-owner.ts':
    'ca0f1111d88b26c7035a93e02157d57f4f3ad7675322b7834aee4e9773a21e2d',
  '../../packages/protocol/src/source-snapshot.ts':
    '7aa1c6b5d5cdb78ef2ab158af74f838f8b7f4b4842a31b622c53bcbcd59fe653',
  '../../packages/protocol/src/agent-library-editable.ts':
    '738b34bf28d24f718609bf2e59c5076d9ef47bb4ce468b91c2561449601b2243',
  '../source-snapshot-context.ts':
    '32ed964e4a9e7d51c2a467d048e9a78ea91154cecd488c69b7f90539612613e7',
  '../codex-rollover-context.ts':
    '4c043831ee4166cd8948b67aa40aa4baeb1a63f307b74385fa8972d4ac67ea01',
  '../../frontend/src/lib/agent-builder-chat.ts':
    'f265793f6c46cccc0d124e205b81d4e1dae9c982eb14e31fe9dbdc327b2eab34',
  '../../frontend/src/lib/agent-library-working-copy.ts':
    'a01d40fae60598dc66ad61e439e11052cc792c936e0d09507a526d3fbf06eb22',
  '../../frontend/src/components/AgentLibraryChatSource.tsx':
    '721dc65918ffdd5ee977c54220636c3cb1fcf7760b59c13aa49cfbe3f21ecbff',
  '../../frontend/src/components/ContextInjectionDisclosure.tsx':
    'ca4fa6b7bf4e6adc17667d40c845d6ba24ea0e561c9d9a2e12d5e2d1a2e3ea3e',
  '../../frontend/src/components/SymposiumProfileProposals.tsx':
    'cdbfd4a2f27bc548cca872b616f1a2d0f1bac021a4dec95a0e24d87a3ea864ca',
  '../session-removal.ts': 'fadb2a3875871808bb898823779ccda1f36a32199389df403f007d56fc937919',
  '../sandbox-inventory.ts': 'c785cab670191e142ef24d819b6e56950c910f7dffbb67613c0c71ac72bca4b9',
  '../../frontend/src/components/SessionRemovalDialog.tsx':
    'a8847d5bc7f3cef2415d1a49d39a8a1763a02723f4ad97588f7b0e21df8dc814',
  '../../frontend/src/components/SessionPanel.tsx':
    '085d90a046cad29225ab3e6ea677652341e1f082a6f4ec13b1c37ac00d9592d0',
  '../../frontend/src/pages/SessionList.tsx':
    '3b9738b0bcae4e4c08793a787a17811e062799c7161faaf976aa02cf2109fd90',
  '../task-orchestrator.ts': '0c25385bc6ace3c9ef225b336379e41d47ecc99ba9f383dcf4f1cdd705c2fff7',
  '../telos-work-role-context.ts':
    'd21fb6e7b3ae8e46f7c4fc2022a6278d7262acf949272893f91271f6590dfdbd',
  '../telos-work-role-host.ts': '1bac562fab4c14747d549234a3955279b8cdb634a654e0773716a7bececca3c6',
  '../telos-work-role-review.ts':
    'badfdb971c6f67d4dc0f6d7fa6fe2b2dfced3e70590c9cf1f4fa3d8bfe62cacd',
  '../telos-work-role-setup.ts': '8f0990272d82af46f0ade034954f23aff88cf6b04459603bac473e79d06b157f',
  '../telos-work-advisor-draft.ts':
    'a572995682705f98c47fffbdb11aff5eb0621f08d826e8584db542f8d89a28bb',
  '../../packages/protocol/src/telos-work-role-context.ts':
    'e41a54085e1e9a0e5381a00a5801b30eccce11b6001dae2dba9529e19fbb40cf',
  '../../packages/protocol/src/telos-work-advisor.ts':
    '6c6453efb49883911a12c494bf85261e21b99d45d5b285248980a85a33b581f5',
  '../../frontend/src/components/TelosRoleSetup.tsx':
    'dd88d2194a07070ddfc6ca385acea2332bff2f928f9bc7f254ffad80412f82aa',
  '../../frontend/src/components/TelosLinkedContext.tsx':
    '56770d51e35ff86f92876d5542749f399235e6a6ba6cd2a7fd046929f58f575a',
  '../../frontend/src/components/TelosItemRoleEntries.tsx':
    'd19a53f26f66a44a47520475e2c9f3ff69c1ae8801253767f0ad88045bb7a819',
  '../../frontend/src/components/TelosAdvisorDraft.tsx':
    '091127d326a458cecab4514ecfe4f9b3244998acc571fccf887479d4afa4dffe',
  '../../frontend/src/hooks/useTelosRoleSetup.ts':
    'cbded6cb6136a45627de2b563b433cfc4b9f80c248035dcdbbfb05c79d9810d8',
  '../research-instructions.ts': '0847d737a765fd2b1c3707d44909d92b186167b6ab34782ea2deb878dc1488a2',
  '../github-read-summary.ts': 'a0484745af976ccee6b840e3955824509669d0fedb1561d6a6ce35c31ebadc2d',
  '../../frontend/src/components/AgentActivity.tsx':
    '6dace0ce097e4c7647a14134f3d75e0d2e76650da4a222ea1e117c7bf04178a0',
  '../../frontend/src/lib/web-access-outcome.ts':
    '89b884c09d8c7b6b4c236bc4cba6fb4b2a775823e55a893f56241b488f39d803',
  '../../packages/protocol/src/tool-summary.ts':
    '69f553304211b38f926b4f4fe81aeae04b177432ccc0002ab95d3258ef07f90b',
  '../openshell-lifecycle-production.ts':
    '1dc01f97b7785277923c16f90982a69c73d482f541fe8d081a4c1927e40a761d',
  '../task-store.ts': 'd8db46138a28be13c612601c1e1435352c1e05b1d6c47deb785804ab397cbbc0',
  '../task-tools.ts': '93b692c7fce06cf22a4ceb8ea66a0f6d287140a79bac4e23cf2c88aabeff5d0a',
  '../task-context.ts': '12de60337242e138d161b29de87fe4132204e7cf4b1547b6e0e52e48ae910f35',
  '../telos-work-delegation.ts': 'dc881b3ccb8335a4becd1c45dda8c612ae056639365193caad0cc09b896156ee',
  '../telos-work-delegation-host.ts':
    'f80204bc86526b806ae42d144bcffacc07aba609925698d300a6ebeeb20aa9ee',
  '../telos-work-command-scope.ts':
    '9ad24adcdacb857116f338a8547ec652b9f4308953b4f5d36eb3e0b57a4e0d53',
  '../telos-work-execution-authority.ts':
    '50e9126e67121fd28e1d00f225cf90310addafe9d3caa0f2ada25cd3394ca146',
  '../telos-work-tools.ts': '385bf4be8198cc30ef96c8c0693a327e7e6d02509b6936ae178f13c05b01847a',
  '../../packages/protocol/src/telos-work-delegation.ts':
    '71f956cb65d618bf9263fa70386efee470346cb320a15b024270ba26b41c5476',
  '../../frontend/src/components/TelosWorkerReceiptCard.tsx':
    '478e884913168fd209081a7be72b841632d982417ddc8eb92eb1fbf0db9eb31a',
  '../../frontend/src/components/TelosWorkerReceiptCard.css':
    '79f5338f99b0d064c6639ef4c4db941cbbe3354954db0b8bfaf5eef0f7bd52cd',
  '../telos-worker-task-tools.ts':
    '2e140e2951102ec82f2c5919b8db8132d4e29b5363fc2b5b1a37926942f2452a',
  '../task-mcp-server.ts': '79180e917cd7acd3680df90607c8e480e7349297bf7fb890418d650b79d46b9a',
  '../../frontend/src/components/TelosTreeConversationEntry.tsx':
    'f5f6128d4539e61d7fc3e18144a8826f34949dee7d91b43bf6a3e06d07d015bf',
  '../../frontend/src/lib/telos-kind-label.ts':
    'a89a6bff28e8ac2fed83ac9bd19305185f6ee6d7a4f7efad196e3e5571a114b8',
  '../../frontend/src/hooks/useTelosRecords.ts':
    'de8243e0d1d3714a92cd01d9119bf03a2f745781bf7c9e64a54bd6cef8b754fa',
  '../../frontend/src/components/TelosWorkspace.css':
    '7a07d02af6002b2ee9569df038ee3b7ac9120ea3ac05f73d2183d8283b37ba00',
  '../../frontend/src/components/TelosItemWorkspace.tsx':
    'd2f3d3e96a0d74a044dd01aad1df4fe99d2fb76a8af563fe2880ee5a730674c8',
  '../../frontend/src/components/TelosOutcomesTree.tsx':
    'b4eca949f6871593f05f94355ae234734bb27decc3a71b13d9ac6898da0efad3',
  '../../frontend/src/pages/TodoWorkspace.tsx':
    '4ef4ba56945500aa99e4cfb550b7c059a33406f532a1e6ad89a006fadae618d3',
  '../../frontend/src/pages/FileViewer.tsx':
    '9b8b8637790030d943979c66e8788af95a7e488122fe15bb9cad4e29c0b2fc80',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-default-plugin-context-sources.patch':
    '41261571d95910ef66500dac9b0589d82e24ac299b22e9a1c9dd78d5c86ebca6',
  '../../frontend/src/components/ConversationDiscussionFeedback.tsx':
    'bd034c1a201f3dc6e125ada3aaa263015ca24e9586844a1c59599a35dc984695',
  '../../frontend/src/hooks/useConversationDiscussion.ts':
    'ee8637a70ef4fc013bcdbd7cd72ae8200e800d1dc9c1253e123a3cda9a3bf55c',
  '../../frontend/src/hooks/useConversationJoiningApplication.ts':
    'f24b00d83f500a217bddce73691b12f5750e8faa9625d53847e726d5d3c6d21e',
  '../../frontend/src/hooks/useConversationJoiningCatalog.ts':
    '8fe2c2c035cd70f5929541e68083866f24c1e24a3b4f31894695c0361bed9c29',
  '../../frontend/src/hooks/useConversationJoiningSourceSetup.ts':
    'da98dd5a4a92892a1ae1518564212ace0e3a932cc0022b1ed95d647b59b9d49a',
  '../../frontend/src/lib/conversation-joining-artifacts.ts':
    '4ad9e03658c7ff3d5738227615b14959c3ad9249836264aa9b2145194bf4288a',
  '../../frontend/src/lib/conversation-joining-brief.ts':
    '84cc96f350bb24a8b9451e41b475dbd7406641b1a6408a3968be378b4f0d10e4',
  '../../frontend/src/lib/conversation-joining-prepared-owner.ts':
    '1079b4e1f91dd0767915f86e37ebf13cc3e6134f105b8ae213243a64b1ac58da',
  '../../frontend/src/lib/conversation-joining-source-owner.ts':
    'f2c40227d8f3cc9a3bc4e4772cdc7a538aea8c76fa1b3bc73d3b0fec6e526131',
  '../../frontend/src/lib/conversation-joining-target-intent.ts':
    'edb05310d6b0eedf0086f2d36096797ad7eeecd01313df3f6bf164559ea049d0',
  '../../frontend/src/lib/conversation-joining-target-owner.ts':
    '179ddb9af72174f4d2b7bac022c74e585d1185c82480627490332ffd2b7b1a95',
  '../chat-event-stream.ts': 'a77fdefdccda2b8bb2c5e3c53d84c161cf145d43e3e014db1083ec40cf891037',
  '../../packages/protocol/src/collaboration-source-catalog.ts':
    'fde9f163f2e3e277c72b34f28cbd89d7c157e02bba8fea66fdd0cffb2b47bd7d',
  '../collaboration-source-catalog.ts':
    '97778f796b842253212bd100a1be79873286e4c13543f6d144d0c0cf5f56ead9',
  '../collaboration-retained-context-source.ts':
    '229abff7f4898c717fd9019523cb0739cde72e6e303f9dbecf1f3bef0ce624cc',
  '../collaboration-joining-retained-artifacts.ts':
    '696cd73f112bf49fba37c06f7d5bc771f617d75749bb39e3551ac95ec1c468b0',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-default-git-context.patch':
    '3693319660e1ee91cd59af45ab74d1d2418e901d049f9f2105784048f79926c6',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-core-skills-publications.patch':
    '7264a410590d1656b5d4993271b6afe4a640e439081b432d41792e146d20fbf1',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-coupled-skills-context.patch':
    '026b5eb684e75e04cdcb13a0b2b23b8760c8d229ed94964155bd8a192837e56b',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-skills-readonly-context.patch':
    'a8221d494e396ad10fecc75d0312a7e99c03b597f69a9b215bd3aeb287b5e549',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-fresh-request-inputs.patch':
    '40bb63a12250c94e3c6d8dda6cc0065d3832c0805fd8864d88a15b3f348047fe',
  '../../frontend/src/lib/telos-work-entry-role.ts':
    '1116a555e86fbd95a99c4addd1d00c55480928d4d277d9c33bb11e7b430465af',
  '../../frontend/src/components/TelosChatFrame.tsx':
    '3264d9f5eb462995b7901fe81e8fd9dc34107af5ca2e4c672c606704c26a9f0d',
  '../../frontend/src/hooks/useTelosChatDetails.ts':
    'f1b2e94eb37468ed215e2c4f9045f67c8d6acda4e8814c66d7938b38e51232d3',
  '../../frontend/src/hooks/useTelosWorkControls.ts':
    '68b5ce268bc6266f09bf3743414e2a2852880f2e0a130cf6ff73b3793c9ccbe4',
  '../../frontend/src/components/TelosChatList.tsx':
    '488b027baa3f9fe8dd8ca6126966004ff2a560b1a8a06a570b685e476e93defe',
  '../../frontend/src/lib/telos-chat-tree-context.ts':
    'd00c462c170663a8868eb29157e9e512c5672473cb0db9ab7611a87794a298bd',
  '../../frontend/src/hooks/useTelosChatWork.ts':
    '1daa58043c0b6f2bd837378b9c120de884381683dd9e4e680d5003c46d6ee62c',
  '../../frontend/src/components/TelosWorkControls.tsx':
    '6f1568aa0156c091bdc999d9384bdd03aeba17bafde40575294c92c5f29868dd',
  '../../frontend/src/hooks/useTelosChatRoute.ts':
    'ec6615ec65d49692c418be6ef5ec7249290dc11f72ccf61a7768bd35b83bde36',
  '../../frontend/src/lib/telos-chat-rows.ts':
    'c7a31faa96b46c2992baadb43e06f968cdac9e54e19957ceb7372b9afca9ebe8',
  '../../frontend/src/lib/telos-item-navigation.ts':
    'da0d9a3b1ad1a525317aa406f5a2346d3ea52da8ec7282caf84b14a63d57dbe9',
  '../../frontend/src/lib/telos-chat-return.ts':
    '82a93d73cc17247366037d16e0909473fbbb8f64b73a1730f1456bbadf701077',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-provider-header-fixture.patch':
    'd4617e4f8c868cd76883310d0cd4768fea72d413a9279d9666c3d216b6344f7b',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-initial-context-data.patch':
    'b6fffacfcb934fd51eeb671d8d2a4003751a01ab640ca2a29d031a0e202a9205',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-context-partitions.patch':
    '945c08dd4d8ee9bc6914c1393624d977c5444cbb96847666cfd3a67b0c288b58',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-model-provenance-import.patch':
    'f2ab3f724083611f435b61f3b432c87cf3313519bb9e8049697f35cfea3107e5',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-builtin-initial-context-producer.patch':
    'f619ed402c154221a0d6920b18bc704e8c1f0b8dd1802a54d31fde45e3737318',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-environment-context.patch':
    'cbf63f5f22172a84534c8ecbee3923fe5a234901d3809a2d0537d8835467a4ad',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-missing-source-policy-refusal.patch':
    '1c87962921cd62d392680f5c77739d313e4cf529ef7a2cab9a91147246123c64',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-selected-allocation.patch':
    '8353c066db35ce16bb110262ef9862d0ca5386b51bce28ddad4f20a39a9592d5',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-client-input-adoption.patch':
    'f7ee3f66efd0d4184c2ada03ed3746872a3fab9f26becca598b79a516126e6c9',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-client-source-projection.patch':
    'c308396b865d06621c313dcda9c7d6dd7c628ac22389899ca3038b6602a048c4',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-image-and-source-fixtures.patch':
    'ec446a7d3a47cef1367abd4781e7e9cd647324cf275170bb84f4c5d1f3562d80',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-installed-registry.patch':
    '4f23421b2c13f10758feae38f751da00789704d65ef6060abb54a882014a3249',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-session-provenance-import.patch':
    '42a30b81986512fe61d9d98941d278171dac1ca98dbe6939913122bbb8dde7a4',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-source-frame-data.patch':
    '0c5637fdec06f2e6d2836b7e6be4fc59764c807d06c5cde14c22099ddbebead3',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-session-format.patch':
    '8af4bc406348c4a03c3875e5113dda650cd8d591ea3eb130235193c552398189',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-startup-selection.patch':
    '4d08edd85cfa0019d2417ee7c46bf440928924218f1157dfe18806c29c6ec0bb',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-public-capture-client-test-import.patch':
    '9bd157355ee47c4bdd4f27a641732126c3f121a5cd34e37ab3894882d61fdb26',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-source-goal-tools.patch':
    '97575e0433900c779b1be773c9c372de36bf6c56accbac06e71552d18c98dc31',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-admitted-extension-carry.patch':
    '2ede5c8a7d5c6d522b6291faf1d78fb0ad5d3f3c7a64c93bc3cf67f0256d655a',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-auth-manager-test-support.patch':
    '77d70742d8bcb7a5e7d93113e70a7ed25ccccb8a50707a77c9688112bd2269db',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-turn-command-data.patch':
    'a62db9c54a14615d36402c2b2b6fa88cf72788de2a00d6b520755951844d873b',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-configured-settings-data.patch':
    'f2ee2b89921c5cc7a85982847cb3ab9b41c39b44370d6f5f1ced03262190f573',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-retained-configured-baseline.patch':
    'cb53fbb73ef67fbf16f897559e48fbc2d6f6093717df20c19fad253cd3c8e886',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-providerless-settings-update.patch':
    'b203d396aed782af897aec2052dc72d2cc2f77c08bfae0071bc0dfb72508f9f7',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-registry-fixture-arc-owners.patch':
    '1d89257e005fefe78cf9949b07699db65e7beffd00a32e5f23f5c188e025f84f',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-settings-normalization.patch':
    '7dbd314d6ba2634ff08bd143d5419fad526a1a63624996d2e0f58e4b2fd4c609',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-config-owned-custody.patch':
    'd886d3eb979496fa7b0b023655a000045e401cff95484cc39a0ba0805c95b9f7',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-providerless-fixture-borrow-order.patch':
    '34b0e7eadcca952719343b3668f59d9eb213c8f259f1005707301164ca37125a',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-route-independent-command-body.patch':
    '06dc296c6f15c57689f556d9563c4b785da64321787b0cdc9af8a8c966f42b04',
  '../native-host-tool-context.ts':
    'd604969880662dd2feb09f6e3cda2b5db2783f35b64a44e891c77a7618a3207a',
  '../symposium-publication-credentials.ts':
    'e1c578eec9297cf567c6ef31ac3443ad8a36a3fb40ccda2149ac18d18362346d',
  '../openshell-artifact-reader.ts':
    '19ed3c99eb86a7792671fed8ea0d9707e0fafe5ccc64e2e5ccfc924484b40661',
  '../native-telos-artifact-operations.ts':
    'ca72cbd2123701e0d7821a06f7363cc609fc4500ecdd726aac4572f50abecf36',
  '../github-main-merge-selection.ts':
    '984cd9a21ee5b40cbe33a27ce732f7a99ee9c9c8593aef0f675121b054fb316e',
  '../github-main-publication.ts':
    '1bd892df28e23131ea01e685765c2d3c2de1fb59813a2800e349ff65da08428d',
  '../github-main-publication-permission.ts':
    '3097f6cb9b2db8c7a796dd87d25a1cd81f7fac07d51f0c000e62c8789bc03fcd',
  '../github-main-publication-dispatch.ts':
    'f915e5793fa1d8d9f0694570bd89c9200f115a8f540280dc2376964d8bb7dd4b',
  '../telos-main-publication.ts':
    '75a5a3fdc0f43637fe8ed1b7f40dae4d49d61b4bbcc62bf511f54fae7ff742ea',
  '../telos-main-publication-contract.ts':
    'e3a679e32461e1d4e9a268244a9b78e785eedc2423109e2f2873bb3998eb07c4',
  '../telos-main-publication-host.ts':
    '7403b776f8b4e7544c34f1b3f3b6da62a20130aa04720c539eadebe3979bbe7d',
  '../telos-main-publication-records.ts':
    '2c476a663d8b85b5bdb563355cb6e1253ccf3a9cc9460ca89b671a415f6d3841',
  '../telos-main-publication-runtime.ts':
    '77b1578af617f99b7cf83e6ce695834ae59b8653667f3d67c23f9e2cf8cf91f5',
  '../../frontend/src/pages/NotificationsView.tsx':
    '1afed3130687c531b27802fcefad0c57cf5003c9e0ffe3ec382b40f7d79ac2a4',
  '../../frontend/vite.config.ts':
    'd16fdd1ae58a1e47b00ffd3a34830e73dbb5a24bd78006cbe9a2f840f80310be',
  '../../frontend/production-bundle-evidence.ts':
    'b6a57cad11c1b602605f2b1407965e10122218082f17dfc8510c38b3a54f6759',
  '../../scripts/retain-production-bundle.mjs':
    '541eec48db5d274bb5cb850a49737ef1a9f5f3584a2e45f8236885afb0333f95',
  '../../packages/protocol/src/tool-lifecycle.ts':
    'd786494647ec605246a1d0a3d0537bdff167dffba435db1e425649c0b8800cd1',
  '../../frontend/src/components/ToolGroup.tsx':
    '58f2da7c38a6df8cf557181b1dadf686317ccfd5ea6d0c049db98afaa5508570',
  '../../frontend/src/lib/tool-status.ts':
    'e1008a48aa56c86caef0a16d70706c6b12e2b1194d696530e149f35200c4a3d1',
  '../task-mcp-selection.ts': '795bac672042497c07627feab1dfb6d7770d8ca00d0a630f867ed5fccb0435f6',
  '../../frontend/src/lib/agent-tool-routes.ts':
    'b38157f1b23ab373c7294898a40aa07c3424fed464ce2ef9f18772541e4779ac',
  '../../frontend/src/hooks/useTelosCreatedItems.ts':
    '3c52064e8d5ddad2233594bfc57651fa0f4492e18bfa5567824b314cbc59ac40',
  '../../frontend/src/components/TelosCreatedItemCard.tsx':
    '7b6bc5b73f1729a8258e03d2a21bf3fd610b668b575de47bf84af4433a9a20e3',
  '../../frontend/src/lib/telos-source-boundary.ts':
    '87d6517e779b9b29f2e636a1919ea844beb0fc034f01fbfdf1c740fa5117ab52',
  '../../frontend/src/lib/telos-source-updates.ts':
    'd04a21a711eb8c7118491d94b1363f02b36b0f7457bbe711906f3d67bdbb6e8d',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-first-command-options.patch':
    '5609b3654669aae0cfadc8e8f1a721a99508bcaa1fb5596971ca9b0f0649619a',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-fresh-history-seed.patch':
    '8538fafc16853427f9f6b1914a444b211e4dbd3c7341fef24afde325f869d7ad',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-turn-input-envelope.patch':
    '80d18dcccc8c9409a6f6cebb9673b2c97347ee605053a24755870c98bd11696e',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-typed-command-carrier.patch':
    '5e19e68d42e9aed2693f91edbd36bcc1ed2e3e84e14700d7e47edb741dd3d793',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-client-info-ingress.patch':
    'a40617f38eccd9f719e7ec7ccbe300ae3ef162ec0c51ce7876f293d6cadefa3a',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-fresh-command-ingress.patch':
    '60332d92a86906fff70df42d9ffefc89fbb758d1c2a92c1f404ffd0f8689964c',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-first-step-model-data.patch':
    '9a698872b18230975bcf73d483b080cf43cbbcadd29b614a835eebaf98f06bff',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-startup-heap-storage-and-failure-diagnostics.patch':
    'd23431be69e78ab01a84dc15d08087d423eb57cd20ef5facc6d4800d68042cc9',
  '../codex-admission-preparation.ts':
    '0cb595a8fed20de735d4fa718544baf1a36ccebf3beecc763badd696e4af3098',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-first-step-context-data.patch':
    'd74bd2f0a29fd41252d08b5e80cbc068f59d6e353bbe70f5d3d09ef63d0e0309',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-selected-first-step-permission-data.patch':
    '8bfff1d5d64a7805f879d920891cc84620933447238491b4585c3b06331540d4',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-typed-input-skills-projection.patch':
    '6b86c78d0217d6df50e8d0e6bedf05b104f6933a81126e74e44d27419ec52c49',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-startup-base-provenance.patch':
    '8389fcc26ef8077e8a84f1a5ebe3f0bdfd4549c1bfb7f677933eb6942342a83d',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-original-initial-model-state-data.patch':
    '146fe47b4a50f7c22253fc728ffaa0556825855a465b461db3d2ac0f0d152a98',
  '../../docs/spikes/openshell-codex/prepared-request-native/native-test-fixture-compile-compatibility.patch':
    '8e5b42b60522d41c94256be832786f3c35408f5abdc8d55dcfe0a359825d96e1',
});
