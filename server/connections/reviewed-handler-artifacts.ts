import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.10';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.178';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../api-schemas.ts': '5e93d3aec104c124adc9c3d1d96abd45d44a78aaee904b9037c743dbb5bf725e',
  '../connections-store.ts': '0143b2eff9725aed9e2d483087719733174974afd26486eb32d7f9335788c3bb',
  // Fresh-agent conversation metadata and offline client projection; execution remains disabled.
  '../../packages/protocol/src/collaboration-conversation.ts':
    '8bdd5ec37c5f2bfa59f79f401bb4955dde9dba64fe6acdc963b5bb0f76745653',
  '../../packages/protocol/src/collaboration-conversation-store.ts':
    '4e5beee2384230e40b662bb84b5aec2f0e8f437b2a51b99231ef33e0d564537b',
  '../../packages/client/src/collaboration-api.ts':
    '05ef5f932a9bd36ff9cddf70971449e25c1376fc539150ff0a523446733e6cbb',
  '../../packages/client/src/collaboration-projection.ts':
    '21028cd31c292b11f9e70e2cac476d478f90d2b278c28b07d942aa153f09060a',
  '../../packages/client/src/index.ts':
    '6ec891ed81e2d18d0fc375cfb8722d06df3831e3b1a30eb4b435ebcf70faba8c',
  // Configurable neutral spares: durable claims, protected controls and explicit host enrollment.
  '../openshell-cli-environment.ts':
    '77f66ceaffb019038fe06479459505dbb37480b7791c596c8e869bef14c2b456',
  '../openshell-warm-pool.ts': 'ae8cf0cf257c43673783f3fc45e606bbfbef0e50155d69f0997679bbcdd81ac9',
  '../openshell-warm-pool-runtime.ts':
    '7a70ce5ac0891523c291d71b13bc57f6ac8f36dee1478a6748d7f4baa9b9a2cc',
  '../openshell-warm-pool-binding.ts':
    'e1f45783d296075831c6330c86a9475468af76fea3fea4e33ffc7e06d585eba3',
  '../openshell-warm-pool-router.ts':
    '4b9cdfd05514839d3828ef89774dc7766bd1dd810639e543ba3e13bc539f889f',
  '../openshell-warm-pool-host.ts':
    '7077eed9f9dc8004f8611cd9b4d9f5554044865f9fab91970455e27b1de0d0ec',
  '../openshell-lifecycle-service.ts':
    '5f6dfd0be3670a181b1dcc68a8633933ea95bf19574d0f3178a68dfcfe03d493',
  '../../frontend/src/pages/SandboxesView.tsx':
    '2e3b5d34e375f989caf5214311d93b0c1a00f6a01623f0dcea053463c4b61b76',
  '../../frontend/src/pages/SandboxesView.css':
    'a130773778bd77fcc144c1ce67d30088d65398a29fd1676906ce99b273bfdd9f',
  '../../frontend/src/types/sandboxes.ts':
    '83dab4a5c3bc009e52c9d16549c0068c9a6df317f5d45cecb4b8a642f1942d32',
  '../../frontend/src/components/AgentToolsEditor.tsx':
    '4a88ed2e2908ab949a4afda4561e2495bc25a138d484813d312244ef4094d656',
  '../agent-tool-catalog.ts': '2ab34d5743bd24ddeb75e786c58860aa88a1af7a2fdde77ee7d0c8d4d619f934',
  '../agent-tool-selection.ts': '61436983d0e156a90049cc516301534f270e51a1d5f50bf14c3b98ba78aea552',
  '../../packages/protocol/src/agent-tools.ts':
    'd4f76bbc478cdac274c1bd9ff75d0d007e86c710614d2836d0c1a9c65d54ed2d',
  '../symposium-session-create.ts':
    '1696f970ee8d8680ce3d73f80cc06b5712dfe78159a1a6635cad81f24e040640',
  // Task presentation and retained execution intent; no execution enrollment.
  '../../frontend/src/components/AgentTaskEditor.tsx':
    '4897a1e58d37ce34dbe126d5a13fe65cb2fc34219e9dbd01153e1372e4f809ed',
  '../../frontend/src/components/AgentTaskList.tsx':
    'dddafd483aad19d3e6267a69b318640f592b645c6236627a1372074756386366',
  '../../frontend/src/components/AgentTaskSettings.tsx':
    'd8b931037fc4f4eafa71af6c7073e5d9f78df19607949138174e902e27146414',
  '../../frontend/src/hooks/useAgentTasks.ts':
    '0c279c93389daaa51781864b8254e716f6e76fc5422e4c8580d4e026ec433576',
  '../../frontend/src/lib/agent-task-working-copy.ts':
    '6839267a3a64555cd4eb3fa2d38353d13cf4ea6c1b194fa711169928409aa058',
  // Assigned task persistence and authenticated owner dispatch; no execution activation.
  '../agent-task-store.ts': 'f1b47b3ee410e5a5727255b5939cd60ab22713858e1b05cd54c2611611143f84',
  '../agent-task-service.ts': '226f42689d54ad511770c22cc62cfdfcad65673e7f5d2850793a043c73f69dc7',
  '../agent-task-router.ts': 'a9569317a35a7e20070f358023d32230d2dbaa00e22534afa3750e0e66cf4f98',
  '../agent-task-runtime.ts': '50a4794707a2c25c9b802813f3327b93356d472dc5f2f698caa3fc463724bd9c',
  '../../packages/protocol/src/agent-tasks.ts':
    '1b56cfe7f6958a042ee1fa0858df1c4a638f90690180a9087f5ef4b0e38a1d5f',
  // Durable references between existing ordinary sessions, without execution authority.
  '../session-collaboration-router.ts':
    'f9904e62fab0b1b50245896fb3a3674ac4949bbcb86c7f16b543b9cdd293fa4d',
  '../../packages/protocol/src/session-collaboration.ts':
    'e8e47f2b79832f0288063745acbed93c7c5f8f4db71f5c8a71705b1b02a59198',
  '../../packages/protocol/src/session-collaboration-store.ts':
    '7361e3e2ad32247ae6eecd12dfe68b2b7b27590cc95d5c46729b503de94bb62c',
  // Saved-history navigation keeps each mockup read bound to the selected chat.
  '../../frontend/src/pages/MockupsView.tsx':
    'fd7891f65bc8f64fd04d63c222425166e1bc05c5cffc69b67f035ddc36ba33f7',
  '../../frontend/src/pages/MockupsView.css':
    '4d1243a3087286f71bbf5b5ab7b1893335266891ba1d6c0cf5f62dea4580aadd',
  // Per-chat mockup discovery, grouping and revision selection.
  '../../frontend/src/lib/mockup-catalog.ts':
    '62a1d6124bda33a1b1a67d4b1910fadb6b04b9cfe7fe678df29c17bb62466b44',
  '../../frontend/src/components/MockupCollection.tsx':
    'a0b9050f26cb194e95e5d3ce0726840221b2dccb9899c5b4ff616d047d85a8c3',
  '../../frontend/src/components/MockupCollection.css':
    '33b7052d3643d7a104f99d2ef3b8eb33a51f0209af471218e1bbd4d89d6ce819',
  // Isolated preview policy, delivery boundary and native endpoint selection.
  '../html-preview-shell.ts': 'e22ca8e8245db06a3e55e17971b5a0c1f890b1f89cd5cc88958a94b180c3e3ff',
  '../security-headers.ts': '1d9f242529d764439353e492ffac07929788455546a68156acf5d4bf852b1534',
  '../../frontend/src/components/HtmlPreview.tsx':
    '70bf4d8caab41e76d245f9763014f164b027ba35603176a38f9482db533cb93b',
  '../../frontend/src/lib/api-base-url.ts':
    '68b440dacf7db8f1afee47cce7fd463002f1bd14e7e4b3f6e391143a9e466f7c',
  // Shared authoring contract used at the owned provider boundary.
  '../../packages/protocol/src/client-capabilities.ts':
    '8dd04e33daf77b98951f93a1e377e79a671a5f9303585c847d01ae895fd9bd95',
  // Ordinary Telos item reads, atomic progress updates, tool exposure and approval tiers.
  '../telos-item-store.ts': '71e0414e15d24cf8c2856c14a739037024ba1657f2481dd2ede9634a25eee7f5',
  '../telos-item-routes.ts': 'b600aaad3c66f6221d526c6a16d11d61d99f761e640f4cc4d9c14bef84b12789',
  '../telos-item-tools.ts': '24fe12678f81c370965d1be0c5855555cfacfd6c841c2ccfe9b8601cd7b44b8d',
  '../telos-mcp-server.ts': '4135db640e0a8f498acc120e22f9962ff6ff54734e5096d228597096ea62ca9b',
  '../../packages/harness/src/tool-tiers.ts':
    'f20dac35032adb67b331d54b3f412bdf6b925b5b19b7990ae383b3fbe4eaaf3a',
  // Approved conversation resources, usage evidence and non-blocking welcome motion.
  '../../frontend/src/components/ChatWelcome.tsx':
    'be4dd3a9269459ddbfeeab8daa3b55c3fdc12bad84f12446a4dece772036ae5f',
  '../../frontend/src/components/CompactionMarker.tsx':
    '46cdcf5b79952216b2a134a47a1605d7e9c7872377dab8505779366f6955c173',
  '../../frontend/src/components/SessionResourcesDialog.tsx':
    '9426df18fb1c711b5c2d95337fb964400dbd740a873a51547eb2fe043fa3bdf6',
  '../../frontend/src/components/SessionAccess.tsx':
    'ea432fe32be3cd61aedc2d4fd8035950e2a3f0eda949733356b22512b9d9db33',
  '../../frontend/src/components/SessionBanner.tsx':
    '1c53c85a30dfb1898ab1d29edc9a40652c1fe7f6a2d52f4a74dad702b8854060',
  '../../frontend/src/components/TokenBar.tsx':
    '25c80275d287086e2e893a12634435470b38358cc17969d4905e1b4bddcdf354',
  '../../frontend/src/components/ChatArea.tsx':
    'ba186b5dc3d2ee5160c54be5acebcb4e6bc2b5bd3a149713142e39bfb80b6467',
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
  // Shared provider search errors and result authority.
  '../web-search-errors.ts': '059b6e418ef97abe994ad92fd37302844ecf11f0dc05e861569be21a49d0f022',
  // Bounded Vertex response transport for complete approved website reads.
  '../symposium-host-tool-bus.py':
    '0a214810f54fd435ffb56adf80f917062c60e3cdf334f88e5aaf429c1f6eb44c',
  '../symposium-host-tool-mcp.py':
    '2cb79bc6ae7f3f02fa0156100c3cbc74524a0523279d873d1851d085a6b19cb5',
  // Explicit web-search budgets and inert readable-page extraction.
  '../web-page-content.ts': 'ea1e6cd81d71987fecab925f0a46918d2790bead3e1321c4d3729afd9c3c532f',
  '../request-web-access.ts': '9ba2dc2968d0fae9bc0c4c9abb9db642facad111c79552a8537751524ec41416',
  '../web-search-adapters.ts': '37048de3d44f2f3017aab3006c7e2abaf5c6b1c3dda1a624dac9ef9e9b8deb35',
  '../../packages/harness/src/index.ts':
    '2741b93d5b35a7542d87757caf6ea9e359d019e74be0dd506188df1a98dffe33',
  '../../packages/harness/src/session-transport.ts':
    '7aaab4c6a3fb5f362b000e7127a8876fb385928d6786145f974ea8ecd4ce283f',
  '../../frontend/src/components/SymposiumConversation.tsx':
    '4096d9d07ccc6b543ade047da065a43d8263cd8d5468b51e3a612e2752d9f8d4',
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
    'e07d4f07e96cdfececbbe829f754620f72d84a44ebc3e50fdddc34bec23e05aa',
  // Explicit Local draft selection, exact-request delivery and bound conversation controls.
  '../../frontend/src/client-store.ts':
    '57b117fac6b16cf168aa0bd5918a657d93889b64a03dec597c6e35816f202e75',
  '../../frontend/src/components/AccountModelPicker.tsx':
    '0d361c3f71c21d1ebe557c288ad0df4a25450e6a4d6703b75f56c98fd912c94b',
  '../../frontend/src/components/ChatAgentProfilePicker.tsx':
    '168cd6ef908fbdf1876e2efd28c5af8121cb1a7feeac07e12c0e7f4e1a795e76',
  '../../frontend/src/components/ChatExecutionPicker.tsx':
    '864e06918bebbbd14a900eb5baef07afab7585dc6179a78cc7bab1f048c871a1',
  '../../frontend/src/lib/keyboard.ts':
    '1e4c48c258c5e1c73be9f9df03a0491499210b9c24baf2fc6d134de41a9c3008',
  '../../frontend/src/components/ChatInput.tsx':
    '295898d37acd714d8b0a0cf4a7f044854d89e002b6335b6ed7540ff616da33bd',
  '../../frontend/src/components/ComposerTools.tsx':
    '932d2f492cb6f82d8bd5fe45223ac61386390774249e73c2d64b649a8419cd6a',
  '../../frontend/src/components/ContextPanel.tsx':
    'e64b65ff9dbb4e5d7e686f189f92c9105b18a8b8edf5433de772515c1d374107',
  '../../frontend/src/components/ResponsiveChatView.tsx':
    '54068b887144f34ef200c8694503666dc95c9ba9d28209237838160abbf70681',
  '../../frontend/src/components/OrdinaryCollaborationEntry.tsx':
    '23d4b7d10ec64b7e3e9daf19d81dd0951ed6c6d3d6602fb0b977e305cc535360',
  '../../frontend/src/components/HomeDialog.tsx':
    'f0ceb4f7ee3f61ae07abcd15320858b63d09c1046786687f0e9ba4ac2aeea6b9',
  '../../frontend/src/components/SessionTray.tsx':
    'da210c89a8dd6821ddd98b1c6429ae58fa6731d1afe98c08a75f0867695d99ba',
  '../../frontend/src/components/WorkspaceControls.tsx':
    '5363ab329a3dcb28b3cf1e5e3466e7de0d55f116b06e5913ec0e4644c0b4e99d',
  '../../frontend/src/hooks/ChatRuntimeDraftProvider.tsx':
    'fcebbeefa5ff14bd074515519a0c4e1d6774ecd7177921ca2264328239cc9720',
  '../../frontend/src/hooks/chat-runtime-draft-context.ts':
    '32660ff240dd5f62c2a8ab976941553a84b7f3809ed3455ffe4e64ccfcd2613d',
  '../../frontend/src/hooks/useExplicitLocalChat.ts':
    '28ece5f7a69035e5bde15896f01fd4419e58a48bd676c0b9157b1db6a4aa1f6c',
  '../../frontend/src/hooks/useNewChatDraft.ts':
    '63427b971465eab55442c1f38cf99e9cf546cb0853ec552a45fc1191758150ae',
  '../../frontend/src/lib/launch-draft-delivery.ts':
    '88b02b396b8222b978d6307ea7a0470123c799c46b3e0e48e9f017fc1bf72b4a',
  '../../frontend/src/hooks/useDraft.ts':
    '1b98e2c6fcf8864ebf2fb45984b926e2ba9fe21f71aa6368de7545d7dd161b62',
  // Saved contextual launches retain their exact source and delivery owner.
  '../../frontend/src/hooks/usePendingLaunch.ts':
    '50d02ac129734f1944e464361413f85afc6ef0fbcbc1ab232de9a7e7a513f779',
  '../../frontend/src/hooks/useStageChatLaunch.ts':
    '607b783bd86d52b78df4e814a13df8f1c0c212c6df34a69026379ebee715bc72',
  '../../frontend/src/hooks/useBriefingChat.ts':
    'd0b124d3acf747c6a2605cdf23a7a0bfa59fc87d2aed1d3cd230e440d2c69996',
  '../../frontend/src/lib/chat-drafts.ts':
    'f44211eac301772b0e8d48f470efc7214dc488f1b3a19c64efa246b543aee47f',
  '../../frontend/src/lib/chat-runtime-selection.ts':
    'b47f7b6cc1bd0d261c7c57560204a1e5d18edd72f58e34e7e9fd63eba1244de0',
  '../../frontend/src/lib/explicit-local-chat.ts':
    'd198183d9ca66823884959d36a8b57416067cde076f2f91016f7e916e07e1760',
  '../../frontend/src/lib/reviewed-outbox-storage.ts':
    'f27a25d30f2890a67aa2b15c7da54ceedc73317aadced7bc2b27371287bbb98c',
  '../../frontend/src/pages/ChatView.tsx':
    'b02403418da496d2a03458247a9f65cb398ae5d3c72d641bb7de125250bdb80a',
  '../../frontend/src/pages/DesktopChatView.tsx':
    'd3f9e0fe84a9f078ac805a625ed96d01fa756c51ed3d7247bbf9ef6b5547ccea',
  '../../frontend/src/types/workspace.ts':
    'c54ac596082365496ebf53ca12ce1602b792acfd09092a216285aa69dd38c162',
  '../../packages/client/src/send-outbox.ts':
    '77957e6cb36b67306416fa1f46d31a34c6f7d72f46621ce1039042286cf645c9',

  // Explicit authenticated Local entry, immutable request and shared startup ownership.
  '../../packages/protocol/src/local-codex-first-command.ts':
    'f719be5f15b168aee7069d0ad9d616426b4f5e88a6e9750b6b331b9e1b032b86',
  '../ordinary-local-codex-entry.ts':
    'd191b66c4672a8003db5022b714a12df5e43291aa23b768e98e791f4cc6d7ae6',
  '../ordinary-local-codex-metadata.ts':
    '0ccfe315aa4bd8b5360608a3a588c3c0545c3fb7a34b3673c9db0156c610283a',
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
    '7e41079850cda5c9599796f3e1cd3810d8cf36f7400781990d54c384a1ed6703',
  '../send-command.ts': '18bc97eb0e66226fd777c77d58597293872c3e6378b071a91c6514511ffe9750',
  '../ordinary-local-codex-admission.ts':
    '4868373c52aa261a89f64afd5ff42d16de8a67f250dc723e4622968a5dfd9442',
  '../ordinary-local-codex-capabilities.ts':
    'bea6fe896ae2956aca4d8b7ec62077ef2d35d0753a94ca78e888a721a26815ea',
  // Owned local command authority and the existing helpers in its code closure.
  '../ordinary-local-codex-host-runtime.ts':
    '5b152f654f029ad43dc1ded3808ea9fe2765b02c753b3a4a414867cbb37e078a',
  '../ordinary-local-codex-selection-owner.ts':
    'f7813b66698d3c777d3c5de8ae8aa5624566f8d7fe8878247a454f0e68da4edd',
  '../ordinary-local-codex-owned-runtime.ts':
    '5481f5a44e7218a1b2c4692b195f55ec16fa298e2209faaaed83a59ab7518df0',
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
  '../auth.ts': '87920c89768d613ce00f84bf20ab405d95e139d96a168595e7a8c6431d80e963',
  '../native-file-operation.ts': '0bdd92a554e86f5adc56f3607ba053eca7de22281343f97a9e6cc5e6c046f1cc',
  '../sandboxed-command.ts': '869823153e5588ee18ce6e16303bd4e8567f52c636e1f3bc4ba3951fba7802be',
  // Shared approval scopes, transport custody and provider environment delivery.
  '../../packages/client/src/sse-connection.ts':
    '03fef53de70e3594cb948ac6ecbfe010979043411c658446eb5e2217911a38ce',
  '../../packages/client/src/store.ts':
    '32ddeeac4956678ed920f150acfb314fdacc8a6afb743eb34d3183d7e6699fb4',
  '../../packages/harness/src/permission-handler.ts':
    '20d09ccadeb668c91008713b45aaffd5762d34c0a6dc1651b3e234732743a7fa',
  '../../packages/harness/src/permissions.ts':
    'e00992d7d86e56d950964a9f6a801f541a425df818a5ff3b6405e2778a1ca0df',
  '../../packages/protocol/src/session-approval-scope.ts':
    'ba694fed805637520dfbfdb160f5d8ba8093a76d1cafe70709dbf18a443423d2',
  '../codex-app-server-client.ts':
    'f9237e6f3bd200722044be249bedd48ff5ccbdabf68f92e4775901092493d8e6',
  '../codex-mcp-tools.ts': '375851fb458c8d930a52a1d3bc32460b2a6174a64a4516af4f68084b1ba484de',
  '../codex-runtime-diagnostics.ts':
    '80730e66ff8aa543acfb4ce035c7cf2fbe936172498d3b8ed0d868143bee4513',
  'capabilities/approval.ts': '25c074b3091e67b0c3faba822e8e2c00ff32a34416fe0b37cb4f202d040d0320',
  'capabilities/types.ts': '2d87b1836d4040bb8a887c17d89cc3ccfab213016e6d276cbb3cdc084a0b9a89',
  '../notification-center.ts': 'a37c82c90d7f6b89e40a6523cf8bde76aacb4f65645100829fa827dc29a49a26',
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
  '../url-access-tool.ts': '3db73be08b7d4d7c06ceac75c75735d6fed9dd3da926003dfb4640e8be691cd3',
  '../web-access-tool.ts': '5850cc94cff84037d50a9e0ed4d47895f06b498d6ef34da21ace23d81f3abdb2',
  '../index.ts': '6500630cb59a1d8119f80511ecf576f3557ef0406f5b694be90c9835e8a72a30',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',

  '../chat-rest-handler.ts': '4154270493f9d370f4661c8853f03c8da778effb7858c9b502116786e1908844',
  // Contributor live-query capture and exact output ownership share runtime admission.
  '../query-loop.ts': 'c4b8d036dfd418981cb6e4643143d6b4928645e529ba1bf79fdaaf3840df698c',
  '../account-profiles.ts': 'd3aa20df7e55c236e59fe3a8e7a3bfe40eb390460aa9745c65c718651452cc41',
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
  '../chat.ts': '871767b8a5c5a409e76136785a0cc12f7be82f120da594fe87f65272435d9252',
  // Contributor execution lifetime is independent of viewer detach/expiry.
  '../../packages/harness/src/session-registry.ts':
    'd5b795c7cf178c0cfd3b8e2cb4a2470b4af25af276f02652ba878e09a9a3ca21',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    'f254cadb334bc75dbb19104fdb7ed2b3e46bf2856b81d29300fd4f45db02674e',
  // Read-only session observation is part of the operator route composition.
  '../../packages/protocol/src/runtime-readiness.ts':
    '6be98645eb9b4467c30f5dacb3e8eee7a9c3f08cb6fc820edc872f789ef217c8',
  '../runtime-readiness.ts': 'ea27d8706c0ae6594b78b22436060eded2848b0cd9713e42fa51597928be3766',
  '../session-access.ts': 'feeeea5ffcf16bb1c4542191a74d5eebde2ea2dbcac7cf0e5315d05e2249b1dc',
  // Request authority and physical review composition share runtime admission.
  '../app.ts': '1359863c48d98f37039873a6d2f4599fb5e8f93e4bc171ed3e2c259f50b7dbad',
  '../auth-check-tracing.ts': '067dc344d8ee76ffe39739a99076f614711ca3d11f96682c842c596a7bbd112e',
  '../telemetry-relay.ts': '302bf6cec2b988ae71a123a5dd04d0f2266a82c3ee51873ec64d8be452c25427',
  '../symposium-review-route-composition.ts':
    'bc2cb2a85517a1f16279fd87757a97b9bb46a16d9efc5f15b52bf41a6f14cae3',
  '../symposium-review-host-contract.ts':
    'bd41408c8dfb9fe4a239fca2e35cf8366bc379e63c4a310d3593cf709a1920d3',
  '../symposium-production-review-composition.ts':
    '5d0e4d78e45cc6d9b3c601cc1f5587c469432bb3ec9edc0c70fb34153dedfc5e',
  '../ws-handler-v2.ts': 'f1420c62d6067a236ce01d5fe4c7704f8c9fa23dde9da778ffc1c30e7757bb5a',
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
  '../codex-conversation.ts': 'a5e631cf462808c96164d58902c9a58332ff330a70479379014cf35a42037997',
  '../codex-conversation-store.ts':
    'a28a891d7e15e599f67b78e9db30fb6b73c24b838b39bd7a86f44d078e6e5d0e',
  // Retained-owner inference cancellation preserves actual handler cleanup and drain.
  '../symposium-custodian-ipc.ts':
    '1bb9c006d3d893c0ab70ff512c8cbefb55c2ccdea7256161b93044416ea00536',
  '../symposium-custodian-authority.ts':
    '5ef9405e845e24f9d19af0820deac42d3404dbd5fb86d4f09f814e45226edd6b',
  '../symposium-custodian-controller.ts':
    'badecc7f7233eed75026a896d04058b8fdf4821ade2e0a042cb74c0a2ec8bbf9',
  '../symposium-custodian-http.ts':
    '5f829b51dde43d1c7615c572ac73b2745c676de0f4f9c39dfd5a2704adc83850',
  // Inline agent creation uses explicit adviser selection and inference-only profile proposals.
  '../agent-library-adviser.ts': '55df1630714da3195653087beec4744af6e3042ec79f73760fa33288ae47ff98',
  '../terminal-adviser.ts': 'cd67017b760d81455fa8bf272b169d649b93c898d0da05552a92ba39f80f5529',
  '../terminal-adviser-model.ts':
    'a94fe40748606b2ca1627579aa7c7d5b341402f3c83db27cdff18b4818808447',
  '../../frontend/src/components/AgentCreationAdvisor.tsx':
    '872b88cbc121b4627be5078f2b73ed079b0a72dec3a1c41c3dcc2e44fc8c4a3f',
  '../../frontend/src/pages/AgentLibrary.tsx':
    'cde2e44336a37719543d4eef6088f1ef5774fab2884bb1af21575e54b290f58e',
  // Read-only tool catalog cards and their shared visual presentation.
  '../../frontend/src/components/ToolLibraryCatalog.tsx':
    'a42dfbd4ae455252eb7e16b0e85df1247e448f570204ac7355ea63da4110f270',
  '../../frontend/src/styles/tool-library.css':
    '23c76aa73788e21c161004a3b06a2b413b909a6d03c277a24817f04ea45e0c7d',
  '../../frontend/src/styles/agent-library.css':
    '2c5810ac26ec0e50a97f700f027d20d0c1cb662dd9a70d0dffa30b913dfde5d1',

  // Library profile identity, operator ownership and admission are reviewed runtime inputs.
  '../symposium-director-routes.ts':
    '71fa6b5d798815b452b26f7df5c58733abb793222bfa21ec71926b8bba2d8e74',
  '../agent-library-binding.ts': 'e917cecf1c86505c8c420590b2e38e10fb2c8808449f70055e979f9588dc5c87',
  '../agent-library-transport.ts':
    '1ddf221a25d11c991b669007ef900140056c321f8bb67d12218940a7dd4c4ec2',
  '../agent-library-store.ts': 'fac60510d3a4b45aa34777daf885142e067538726104c749f4ebe533861472c7',
  '../agent-library-router.ts': '09788a2df86f8bda237bcce03306639b526e37a4bfbdbd20d5de1d069d66ae6f',
  '../agent-library-runtime.ts': 'cc3be2fc2f61053d4430960a2328d41146463fdca701840a92ab65a89b29922d',
  '../agent-library-prompt.ts': '3be39c6cd2fb12c744c5f53e45b8c8b306398146edfcb2af479d4fa1c9159c28',
  '../symposium-profile-portability.ts':
    'aadefe0eab442dc27ce68b86654291299dc6664a185b903af44756f79ff26680',
  '../symposium-profiles.ts': '4138fce2cc44220fa90b3ef65b207b89c06a5f02cd24750a748f79d84d297c95',
  '../symposium-custodian-protocol.ts':
    '1a07f1725f1c29a3478f78f9f582d69cabbd35b17c08dc3badfb2f6cb9fb2876',
  '../symposium-custodian-proxy.ts':
    'beb0d632c863e1486911e1c4b096ab65be34ad09faee7587ef21dc83d00ac6b9',
  '../../packages/protocol/src/agent-library.ts':
    'c9c5fadf380fc72edc81ec7b762d1f69620d06dff5ca40a949568ee61a2a068c',
  '../../packages/protocol/src/symposium.ts':
    '129fd172bc38c895e31d0835adf799933ef7641a200c33a3b8135a2e318b848a',
  '../repository-chat-tools.ts': '74e686017b043f61e063258aadec9387f2141e5f5a94238bfdcd6780b3006a77',
  '../repository-task-copy.ts': 'cd15f77cfa45883556d10536296a28f7451d2259a5a3eb2a9aeb807d24c54d6d',
  '../credential-connection-schema.ts':
    '3489ff131cd0bc28de23d85e1ed7cd4749fcb12f062bdc76407bedc0efe28f47',
  '../credential-verification-error.ts':
    '1adcaa9d47b413796b94f6aeb44bf152e2daa27ec30759d1ffd9ce5e1240ebea',
  '../credential-setup.ts': '8dfd54d1b4cb4408d52c9ca09f5cc220ba69adf6dc6181bc7de6803fee38f69c',
  '../connection-guide.ts': 'fcbc53ad1654e6360ba0fab9287393387cd94a666fbeaecd597deb501443756d',
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
  '../credential-sdk-tools.ts': '45d500312c188a2a00b3115c1ec4d2aa5045f775147b5f97eb80e130849b708d',
  '../session-credential-tools.ts':
    '2de264085b8df6df275044b451b33d0f9f24e3a4b66f9a9f53280f71080bf18a',
  'policy-compiler.ts': '59579f9eb69a3129dd2d8e1676fa46bd21da45c07f58752183416c82c0986014',
  'registry.ts': '431c78947dfcca432ece96d0d708f790705484443b9bbdf78c2edbbebc4a4216',
  'iana-address-policy.ts': '899b0b5ad66f5cbe72224b34c29ff7a88e32c2a6f5b2987e4d18cfc64f862b4e',
  'iana-address-data.generated.ts':
    '58f91383fa17ab9612d24bc113d011ece63bfc06b4635ba99f108bb05aa34038',
  // The capability binding is not trusted merely because its manifest is
  // reviewed: both the production executor and its OpenShell/Git transport
  // must match this revision before the registry can advertise the action.
  'capabilities/github-publish-pr.ts':
    '40e45185db8ba26c3e43c3b81b783c3d877ace75510140602a43a9a6a56c1ff2',
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
  '../connections-router.ts': 'afb2657c850dd4b3a64cd2d295ca8682204ddcdff0dba90ce6fa610c15596e93',
  '../connections-service.ts': '930b9fea2c31e82edbe16ab1cab670e338cbe4403f621ac7c6e744869fb9c905',
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
    'a0b2ed52adda81a5ad99ea5544829862df2dd0716ceb5f57d8d3d43512833e46',
  '../sandboxed-command-worker.ts':
    'f2cffea266ca292c2ba690725820e2c23d4a90fc3ed61619540a960bbfe72f23',
  '../protected-sdk-command.ts': 'e7c59a2ebfd3fde4b0c7c8cdf7f69f9d231e2e5f1819a61e0514cd707bc6c32f',
  '../native-hooks.ts': '5708a6e09129765ab760a6c078fb2571dc73dc1125c9be31b43f1865fe5e461b',
  '../hook-bridge.ts': '8885c2b27079799d33958a17942bb7d8953d01540bf7cd4b3ade537ee39c2d12',
  '../native-tool-executor.ts': '95799f43eed7d0f818bcbb1cf9cc504d99168bc31877f4f17a19ae9fd0539d13',
  '../repository-workspaces.ts': '361fdcbf839071978a0912651ef4a65681d0bf0257a650bd144a8e1f5c9a8f34',
  '../../packages/protocol/src/session-metadata-store.ts':
    '0b8cd73207cca8d62405b1de64dabb73da47b4d19b6a83801259b24148e9db9f',
  '../../packages/protocol/src/event-store.ts':
    'dc8723f5f873242ef92566394477d11ec2474ee31c2df8c8039c3b8d9977d30d',
  '../../packages/protocol/src/session-lifecycle-store.ts':
    '2a219b360a5fbe72b0a550c714bf76a15c6f5969cbbe4251671050257b98e267',
  '../../packages/protocol/src/conversation-replay-store.ts':
    '60ca279c37909d56d842535093f8d8186057a668a1b03a8e53c41f92061da32a',
  '../../packages/protocol/src/execution-ledger.ts':
    'f30d210be1d37f4c61ff47edb1fb3c8dea1dc6fd8d3ea02b6e01310e8d44ffc4',
  '../../packages/protocol/src/session-runtime-binding.ts':
    '074c03124322359a02795c7865a718205f80f8aa9fc6b4e0b5a8f43746d6ca4d',
  '../../packages/protocol/src/types.ts':
    '003af8421ad84c724b9f045d2a84f1e5279012b711b3c8164a0130a4aa5d5342',
  '../repository-workspace-runtime.ts':
    '7ecbc2a5661b4e48d938334d3da3839f75085bf28dde527e4d48f799d11e7db8',
  '../repository-workspace-router.ts':
    '2416539bdd3b668523080429c5b088ffef522f2f66c02efecf66f78ba8661593',
  '../trusted-native-operation.ts':
    '81d1ea0c643053fb6a6f0b740b3767dc0cb2d7f4a1ee6739073923776ba5f918',
  '../repository-chat-startup.ts':
    'da5476aa7e43badb1809a8f52d958d5338ec921c6ab96531978f750fecf4428f',
  // Admission shares compiled connection authority with gateway provisioning.
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    '9733d55cd1cb15dcf68dd844fd85861bf4fece6f3d46e1926ec9c416dd59d7f2',
  // Task command inventory and workflow routing share the runtime review contract.
  '../task-runtime-guidance.ts': '6e308de61b1579d0cb47a1873b5723c1dda792d8284fcc5abf10752544eb7fec',
  // Batched knowledge admission preserves verification and retention under the lifecycle fence.
  '../knowledge-view.ts': '0582477ca1248067b1c10a97509f0a518343a8aa388f669d8297ef45e87b8559',
  '../openshell-runtime.ts': '460495947fe471cc0ee00a716e26de74ee48b1e2e319324d21e7590477116f26',
  '../codex-chat-session.ts': 'fd3189ecbaeddda8a5eaa0156409c6d8efd449d0dc0786979a765c7f456d9d2f',
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
  '../codex-approved-search.ts': '511b6ebe13277607afa9f3fd6990a100d828151962abb2623c65e4ef212d456b',
  '../native-codex-context-admission.ts':
    '91a021e0dba7a2e1d38cfe2a744da603370f562f5d78c25255237d4065eda558',
  '../symposium-host-tool-bridge.ts':
    '93559b7b6a5aeb1e66e633d2038cedd774d1a9efe1e8bbfc20d83c7e13326ba0',
  '../symposium-seat-authorization.ts':
    '26006d392e10e68c695e00039935332c28fb7146feaa057e482afa38c4f1fa21',
  '../../packages/client/src/protocol-parser.ts':
    'ccbc13b4b3b902b54b52befdb304b3b0e9af2dc284f2e62039d05424fc0bc99b',
  '../../packages/client/src/slices/messages.ts':
    '4bed61fceaa9a34613c2c923bbc6e2c74d6dc66ff04d8b897a513d41af66a9e2',
  '../../packages/harness/src/providers/responses-session.ts':
    '8e2db677e8648488c25f50aa74604fd734b694f230ab137436481fb62aacaa74',
  '../../packages/harness/src/providers/session-types.ts':
    '53af4d3c4c3cb3d3e3179ca306689aad6faa03669d9ad62d652e21d18babf8b4',
  '../../packages/protocol/src/agent-context-pack.ts':
    '6964f27523d93a64c153f2d3a56650298a2063521abdafffa0c19c3dba839de5',
  '../../packages/protocol/src/index.ts':
    '6e24905d6de55157dfa056c4741c0270ce7905a4aa1fdb85982922e6659a2c59',
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
    'e6e5ca0b462452b5513608ea91b2b59b15c37e92010b5ece93da6cf7199ddb4f',
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
  '../telos-artifact-tools.ts': 'f9a7d2f13e735d576382fe0e7f04082f2d1a39e90b7b47870025e7c76ceb63fa',
  '../symposium-agent-context-authorization.ts':
    '497a2c4bbb4ca61892e392b11fe554bb88d5302921eef7305f88e74d03c206cc',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../packages/protocol/src/ordinary-openshell-admission.ts':
    'd55a6266b2d5b4df95b9ab2e92526032de1ea6f080921f5adc4d182fced38f3f',
  '../host-codex-custody.ts': '684485006e92b26780a32b7f76d3bcd5086ab7492bc43508414d278278d4a9a3',
  '../interactive-auth-core.ts': 'c91026beae6b68449c50067ebaea0046fd0c551607719ec1c04b6e4ef5e5d114',
  '../openshell-codex-custody.ts':
    '879381e2a91161c01c257888cc6760203e505fc43f84ee9e9d84558ea60f695b',
  '../openshell-lifecycle-controller.ts':
    '2587c8f2686b26677b5de8a983a41e735a90f9f70e6332cf9da780c5bae9a0c6',
  '../ordinary-codex-continuation-status.ts':
    '047c367c317b24f64dd346d5deeb67360afa0fdefa3e2ae12e05f52382401a24',
  '../ordinary-openshell-codex-entry-owner.ts':
    '0bac6e9d3bd1d0919a0f7e9d2dc823a53574f41c80ef72cb1e5da5d81ffe5009',
  '../ordinary-openshell-codex-entry.ts':
    '239b7334207708a3e97ca82185d914a26d7f9ba85ac52c40b0d51723a9e78439',
  '../ordinary-openshell-codex-owned-runtime.ts':
    'f3a68b9af4acca882974c6748bdf7db9c80fc85e5a795e2a23b0211fa41b2f90',
  '../ordinary-openshell-codex-route.ts':
    'f0bfd42b4dd663d2577d77ca857fddb9a1ac67d6a894f440b08764b7b33191d2',
  '../owned-openshell-codex-chat-admission.ts':
    'f191340f2ebeffa6e4b243ae7aeb64b919c6ac703239c1737a7e6529a17cb439',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../session-registry.ts': 'd91b89354926d0ec7355e73fcae4f41066008d63097ca00077f37022fc554ccf',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../approved-url-fetch.ts': 'c6c1d8bc1b678a1cafd0a63f52b0344664f9ee5e33fb66f9b99a10d0b491539f',
  '../owned-codex-queue-control.ts':
    '00c6dbf8ada1f6da8b519600380470a1a42090e125877b79a6149fd7d9667e9c',
  '../public-web-fetch.ts': 'c5fc6be1b97cc0049fc645bdb102e44408cbf9bd61c55f63ee55bc96d52b31fd',
  '../ordinary-codex-agent-context.ts':
    'fcf7bc0b5c5942913671ee9c0212b7122d0cdf769ce49806a1047f14158a841c',
  '../ordinary-codex-agent-profile.ts':
    'a83d9251d9db45361ee464b60e152df60d07b1b257d833b64afc9c2582f12d7a',
  '../native-responses-store.ts':
    '447f5522e459a431caf5e45dcbce6d1effebc8ea6402e58386c6178db5051a41',
  '../ordinary-local-responses-capabilities.ts':
    'cd24e1f31ced1015908efcd79066289f20f15760098f626403c036f077b3e390',
  '../ordinary-local-responses-owned-runtime.ts':
    'd78b7c1e9ef99ff1f3cb373d9bc649ec4c335b2b08a8f8eed3c032188f4f32b3',
  '../ordinary-local-responses-queue.ts':
    'd2c8999d608bc7ff76eb9ea113094df3a55c9bf861e6c5ad9f876531fda36fd4',
  '../ordinary-runtime-capability-composition.ts':
    'bab973501ae7cc341811d8271d31283e76f4026e1465c7ee79111a0cb47c799e',
  '../ordinary-local-vertex-sdk-authority.ts':
    'e0543f3bfa5fef364704228592d59173f7035730127c8b0a46f75ffaa4526487',
  '../ordinary-local-vertex-owned-runtime.ts':
    '185696b711afc4c559ee6458748d76d26224953b8335d74cb461de4e3f81d0d8',
  '../ordinary-local-vertex-native-history.ts':
    'cf1078f41c2e9bc23831231b980f8202f2e615401867a9d90502c6d64191c22e',
  '../ordinary-local-vertex-custody.ts':
    '7f1ce782be5190881004a63aacf58d8df69acb0fe46d9bfe952c436cf6c2aed9',
  '../ordinary-local-vertex-entry.ts':
    'f3706186ebfa23a9e593dd588e1d0756d8fe577879696af41d9ba457188f8028',
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
    '09b59817a6877cb6d28ecd7b3a83169780a5ce39a420c720561cd4106c045f64',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../frontend/src/components/CodexQueueStatus.tsx':
    'd184be19fe19f7b29b2376b767f0f383001ff40b87e76b3d723d0c0431ecf265',
  '../ordinary-repository-preparation.ts':
    '92449a4b17e879447c81aa2e853537a4d3780edae04c730365bf2820af337490',
  '../ordinary-repository-preparation-authority.ts':
    '553c8824142059cb15797f969d492f54ac2c0b79ebbd41734009228749a44a52',
  '../../frontend/src/components/RepositoryChatPicker.tsx':
    '6eafd2ece6d8a288b62aff7b0be56edd435459b67d2eef9e542e0f595b77dfb4',
  '../../frontend/src/hooks/useRepositoryChatPreparation.ts':
    '21b62231f1f15b14e874be59d01bd23316f4b7ee516d514500d7599c7c653fde',
  '../../frontend/src/lib/repository-chat-preparation.ts':
    'd800d801ee8cd47bd102381a83e956b6d967db8480a8fa4e3cadc6f880d18786',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../ordinary-command-historical-ack.ts':
    'a5301e8f86add7c8e88cfc39fb091f218645166b4400ebc6169e576bbfef12c9',
  '../../frontend/src/components/RepositoryChatPicker.css':
    'f6b45e7b9dd2d365fe3bb162cb08ecc4e07604ce468936cc21d634f0a8d70062',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../frontend/src/components/AgentSettingsPicker.css':
    'bd30b16df165a784f34285058165f6e4cb6dd07839da21fe258be8410303d408',
  '../../frontend/src/components/AgentSettingsPicker.tsx':
    '95da9690c48e3afcb0f3c6a7f676bc980cfe4cb0b97db26712997d932441e1f1',
  '../../frontend/src/components/UiIcon.tsx':
    '0bda160e1f55b845fd274492144504b76442730729397028db617ef8570b41ab',
  // Responsive controls, bounded reads, authentication recovery and operational observers.
  '../../frontend/src/components/AttentionFeed.tsx':
    'a6439f91736fa6e604bf66638c7127cfcea256137a2ffc8284cf667772965bc4',
  '../../frontend/src/components/NotificationProvider.tsx':
    '5c8e900478b657b157119b52ae8f4325668a8bf96ace930f47de515a068f569f',
  '../../frontend/src/components/ProtectedRoute.tsx':
    '0217ccae0e21246237605d9b047b2f5695ba3cd7c87a98266cd50473828128c7',
  '../../frontend/src/components/TodoCard.tsx':
    'ac794c67dce156ebede1aa75908600a228f7d571af23f6a43dca836ec729ddf3',
  '../../frontend/src/hooks/useAttentionFeed.ts':
    '8f10be65de76cf721b6533c336428e3144c324cec9129a6b437b054b07cd1a22',
  '../../frontend/src/hooks/useCalendarData.ts':
    '0755998ba06d85a187eb248a9a9e34e925790c10c69b3905f6f7eb2e52e7f79a',
  '../../frontend/src/hooks/useOutputContributors.ts':
    '958852b928bc0f819c2badaada2a37fea725d81f0d1cc09c6bf64804b6b57f8d',
  '../../frontend/src/hooks/useServiceHealth.ts':
    '807a95678c49e8bdc2dd7d14979d0fd90a2e4364d51c34c2a859ecf0dfc81d4a',
  '../../frontend/src/hooks/useSessionList.ts':
    'a53f6b3c6f369f92c283a161c89925b79b290add87dd2b57f110c4f97701db24',
  '../../frontend/src/hooks/useTodoData.ts':
    '2fdf94ff9719384bfbd247218f68a99efa6e243a1560bf287088620a4f12b39d',
  '../../frontend/src/lib/api-fetch.ts':
    '39ae0be32bfda66e5135dbe287eecb5cb5bce0c74d3e823897d6363d040bf9ff',
  '../../frontend/src/lib/api-json-read.ts':
    '60c11f4263ea1e73478e4ff54542968d65c455b36ab9eb3dbb718d02abb94d18',
  '../../frontend/src/lib/auth-check-tracing.ts':
    '7ce7949ea77d373206b90e9cbe59254f4e76df03624eb7c2f0db2936ca79b012',
  '../../frontend/src/lib/biometric.ts':
    '7b107f137a143c9d30f9baeb6b685abe813d7a5b01eac33020014f1f1db33173',
  '../../packages/client/src/api-client.ts':
    'a19575a8f5cba037f6aee6ac8c8e475131a3d2a0c7236d8ea8e0b5048f3a0181',
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
});
