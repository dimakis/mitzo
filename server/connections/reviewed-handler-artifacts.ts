import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.10';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision = 'v1.0.300-custom-tool-catalog.2';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../tool-builder-runtime.ts': 'b854fbfa534a8d47f249e1ba8edf65009719ece8c2718d213f29589001e47f05',
  '../installed-custom-tools.ts':
    '103aa54c9df80d683bb0a8f58fa296970e5be0bad0a37acb3a7b2b7e32079af3',
  '../custom-tool-admission.ts': 'e226167e0de3de25e01f734686eaa97a8c0dc69a43fe3e6623a1b9f7a55763b7',
  '../../tsconfig.build.json': '88fd99085eaecacd39e0d1464b42f00d622a0a5c356ca8ae035ff72ca7336434',
  '../../tsconfig.json': 'cae7a19ce257dcbee4915ea3e51c78f131323bb9ca98d7b4302ea9a0de1b2f66',
  '../tool-builder-test-runner.ts':
    '609f8a11772a4c4762113a3a398347b1b23b4626890d2e23990f39fccbc4993a',
  '../tool-builder-workspace.ts':
    'e500e29c5412c8954408a3e965572128300f5ba95de997cc02479452a936e1be',
  '../tool-builder-schema.ts': 'b55fb292b80f3f1c5ad9376a27abaf62b901cdf07e5fb62ce07cf7fbc17a419f',
  '../custom-tool-registry.ts': 'dbfc32113c4af78d5885e77d1dcaebb10f82cc1931c552aa9fc829e996ffb0fa',
  '../tool-builder-router.ts': '098b60cbc463a81cb3a43fa45a6fcd0ddba309ae6c4ef1ba3b69a26c2c916bd5',
  '../tool-builder-store.ts': '26ec2fa2c3bccd7a2c1fd41dbf4a0b3f10116ff97a3f684a502445096da06e3d',
  '../tool-builder.ts': 'f086bdabeac717acab30aa0433a5b2eb17cafb82ec56126009ad6a5a58a01b61',
  '../symposium-access-tools.ts':
    'f5ee50c9bea25c0453b52941eb186f43e8de6efa674736eab22348ac08b59032',
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
  '../public-replay-error.ts': 'a74dbfac1901169ec1d797aa6c5d06bac6d718fef1f602963ed7a874e0fe79d6',
  '../provider-failure.ts': '0655ed00d881906318380ec0c90d62f1457b5257747eb765d05658199443805f',
  '../telos-source-recovery.ts': '91d1921366236f855fa2283fb35aa64641d1a2b589e5b2dcb7c24250d94dbb91',
  '../telos-source-approval.ts': '4ad333423cd049bec9b2b2f3ec90b71fa53d9610521166e1b48a1db7a416b275',
  '../telos-source-approval-store.ts':
    'ffd3d8d4226f62ce44e15f25d48d8b251f83f7e2d771c89a50aa560621c43de5',
  '../session-permission-policy.ts':
    '0c3f4a314ea87d9e9fb55daed501c0958aca664cd6a3ccda22c4fbe07c7f99fa',
  '../../frontend/src/types/ws-messages.ts':
    'cfbebddf79a141d8affbdae712178d0d15e16382c959b8d8c4a766073fe4976e',
  '../../frontend/src/styles/global.css':
    'b7d58a6d48a82775c95eacf3965050e6a2ad9dc775eef37914b405b93d0fddd8',
  '../../frontend/src/components/TelosSourceReview.tsx':
    'e501290f74a90903b94fdc3a3c0b81075e72be6ed3b30e60a68ed4f3d38479ee',
  '../../frontend/src/components/PermissionBanner.tsx':
    '4706f371b3cdf9f80ebe40b673d4ce326b3c09a4bc88f30954f5dc4a614f03d7',
  '../telos-artifact-routes.ts': '1c08c382dd14fe90ada4d9fdea4224bf91b9b82143e15cd462f90132595089e8',
  '../../frontend/src/hooks/useTelosSourceNavigation.ts':
    'b2a461e208923889e0286efdd3faa41705af58693de41446aa6021eaa4b73fd8',
  '../telos-outcome-handler.ts': 'fd01a401e79d08b8330aac5da419d11c49e07d767edf2bab34bea990cf04168f',
  '../../frontend/src/types/todo.ts':
    '91a8e37caa5378df768537096bb03267cdc753c718ebfe3aa1b7b1732a14f35a',
  '../../frontend/src/pages/TodoDetailView.tsx':
    'cd5c864626c0a3b791639334f606366490990a1ec10931e9d100be7c31a942ed',
  '../../frontend/src/hooks/TelosSourceNavigation.tsx':
    'dac7bb547165c32a1c14f023a34ed371de281c9fab1c9ab41a93f522f6d60598',
  '../../frontend/src/components/WorkOutputs.tsx':
    'a4e0b7c2734cd59774d9b89fe52db5be5d3d2014ef0c03a5cc909009363305ff',
  '../../frontend/src/components/TelosSourceWorkLink.tsx':
    '46de398745ec3f05f613ec1d16fecab5d22a844a67179e47eb35d3e56b21d647',
  '../../frontend/src/components/TelosItemSources.tsx':
    '5f2ded9f696d667a622dd59aa9d3a16ad01dc6364ac7d1d35a1ffdc7d2ff2d1e',
  '../../frontend/src/components/SessionWorkLink.tsx':
    '2f8f334d977d32d40d2226831cfef7ecd2f06a755b3240c2f0cf4e27095f28e4',
  '../../frontend/src/components/MessageBubble.tsx':
    '3c9b7018e4fbf623dadca449596e6025a8f633f72e7677f0c59b4bd5f14824b2',
  '../telos-outcome-owner.ts': '5f326429fbef7304aa0d897d0e78281f91aa881aaddb53529a9b45b685b81408',
  '../../packages/protocol/src/telos-outcome.ts':
    '2e02bc7096e531552c3eeec437f4e777d5b9a14089c3d6a9eb00b5d7942bf758',
  '../telos-source-routes.ts': '9fe592fae24c3ecb1a0915b0370b4e525facfa4b34a473981c5cc8e032187cad',
  '../../packages/protocol/src/telos-source.ts':
    '6ca8887c2d88f73eb14a5886e441da54c0036f0767392f4e72352f783d33eda7',
  '../telos-artifact-store.ts': '1d7e2c5e2b6627b4eff7860b2497fe97dc808fe87d1f89ca28cd36b85e04bd50',
  '../telos-source-capture.ts': '474d585f84017422fbb707ec5e0212c79c4a04747979f78b55956a9e1f999526',
  '../telos-conversation-source.ts':
    '0217975022f987f5ad65876d53467417774e3f0f186ba4fc70bc6f30c9860308',
  '../telos-work-record.ts': '7a1da4212ae06394702807b31421c371fac600904fa526937544587cbff56d93',
  '../../packages/protocol/src/stored-event-wire.ts':
    '299edbeb86bab57c9f910b27cab5d6753ff026106916d58f4a9a2dd5deedafa8',
  '../collaboration-ordinary-replies.ts':
    '599f1574e4fb2deace9d5b0aa19e639d6bd7aed727837d404f44ff916eba8a5f',
  '../codex-session-events.ts': 'ac907391d5427c054eb4b2d5d64e28c853b5b5c52cf5bc689467aec994e532d9',

  // Authorized ordinary visible source and exact inline output access.
  '../collaboration-context-source.ts':
    '5feb8135ccfd6d578ec5f9ac873bd7c260322d49f30d831147be29df3f084262',
  '../../packages/protocol/src/collaboration-visible-source.ts':
    '689c1925f2ba21871adbda5d79201d786cd88a55ed0b383130aad668e005b4f1',

  '../telos-work-conversation.ts':
    '6abc340f3236812d9e9875e8a60944590575d991e95ccaf3f2b61aff323c5175',
  '../telos-work-routes.ts': '572567dcbf9aa71b95f7aa1a6a6aecacebbd6c1c3034fdb73e9707360cfbb29a',
  '../../packages/client/src/telos-work-api.ts':
    '25ed84aa3daa8ee86404b63a687d1e571f3b160c5c1ca23acc31c313318283a2',
  '../telos-work-schema.ts': '35da5384517e0ba61cd9324ff825ab1918a6c6f3ea126bff45a822cd10206612',
  '../telos-work-store.ts': '2050bdb8e4e63cef8565240ebdcb26e60fb648abccd38248f1deede40b113e5f',
  '../../packages/protocol/src/telos-work-api.ts':
    '4cb6af6268bf48f775d21e3ff9bfeea0d77110e1a9a96e8f185f85a630c8e332',
  // Recoverable tool validation and confirmed Telos creation receipts.
  '../tool-input-error.ts': '3fa8bc111278d03dd33014cadc8535069c49a12ce636cbbc33126b76190bd3dd',
  '../telos-tool.ts': 'a21d66aaf087d882b78403d335453effa8e7411220d5537b71ff0c271cf9e824',
  // Frozen joining review, exact-request recovery and shared dialog/motion presentation.
  '../../frontend/src/lib/browser-crypto.ts':
    '5d10eb99cc0f0d8cbabd7eeefa9ce245bd14c8f32921edbf197a13f4b849b270',
  '../../frontend/src/components/ConversationJoiningReview.tsx':
    '281a3331627c21bbd34149d697927291d355da0f0505d1b5666647219bfa7a31',
  '../../frontend/src/hooks/useConversationJoiningReview.ts':
    '1c5b67de86e13680ae212d1bd34e0528d56e59f8a63dd534e00edf6eb4405a0d',
  '../../frontend/src/lib/conversation-joining-review.ts':
    '522a7df7880187236b963b01b38149ccc0f7ae2fc1e3ba1f46164d9903c676a7',
  '../../frontend/src/styles/home.css':
    '284a0c689b4f3071b6e07e097e89cd03f90fb7d4ee6d5f3a956bd35cbe588556',
  '../../frontend/src/styles/tokens.css':
    'f028f328310f111d619e015e09774c02e5caec9049863756d77095425b82d97f',
  '../../frontend/src/hooks/useMotionPresence.ts':
    'ace66416845a7e8a85ce17c07c8310b4b7089e89f09ce6e8cb7919907d035838',
  '../../frontend/src/hooks/useReducedMotion.ts':
    'bac83b87d2170b27345c415117c7ec3af58071633433e58c0ac57b4cfe8318b0',
  '../../frontend/src/lib/motion.ts':
    'ad00f4a8c52926e6b4527c84d9abd38935b538c9452566395a5bb8b998540589',
  '../../frontend/src/types/account-selection.ts':
    'd866165714758849b0ac5e5d578971f5f12742494b747b04bd1d31f0045c9650',
  // Approved Agents presentation and retained native composer adaptation.
  '../../frontend/src/components/ConversationAgents.tsx':
    '48696180754aca127bb0224121302a9453f262ff7cb85b78762bd2ed33d7ffe1',
  '../../frontend/src/components/ConversationAgents.css':
    '67b0a7dfde19ce25f31fc5ff2571fa111f20ca323bf8220d86906899ca5eae16',
  '../../frontend/src/components/ComposerResponders.tsx':
    '947179a55df150bc220a2b3d8434504c9e9668220155db5d2fd863440faba06d',
  '../../frontend/src/components/ComposerResponders.css':
    '29b0c05f64bc8555d35a759c7054a950cc70f57a7b49510262ae3b3b1e51f97a',
  '../../frontend/src/components/RetainedConversationComposer.tsx':
    '6be25f820dbf6770f063664ce19429fcfc986547cd8ef397f996a4294b8317d7',
  '../api-schemas.ts': '3da308057740950c819f0338f7f00cc6ad69b923d067ee6098a41fc6c5b3f80c',
  '../connections-store.ts': '0143b2eff9725aed9e2d483087719733174974afd26486eb32d7f9335788c3bb',
  // Fresh-agent review compilation and metadata; execution remains disabled.
  '../collaboration-context-compiler.ts':
    '9a29ff1be1dbba5c9c0c46ab3e4e54de70304af0429adef44548a9fb149283bf',
  '../../packages/protocol/src/collaboration-conversation.ts':
    'ba36974dbb2d289d3568c159704f0751982071b48b6b32ee23656ec6a5464ea3',
  '../../packages/protocol/src/collaboration-conversation-store.ts':
    'cb01ab9d6dd9cca3ce81782a45c2c53cd54c26cd2c72adf909bb6adbf96067f5',
  '../../packages/client/src/collaboration-api.ts':
    '05ef5f932a9bd36ff9cddf70971449e25c1376fc539150ff0a523446733e6cbb',
  '../../packages/client/src/collaboration-projection.ts':
    '21028cd31c292b11f9e70e2cac476d478f90d2b278c28b07d942aa153f09060a',
  '../../packages/client/src/index.ts':
    '529e2c6f580c5a2f110d742a95addcb98d9f84a9bea05e9e896c2c5f0777a491',
  // Configurable neutral spares: durable claims, protected controls and explicit host enrollment.
  '../openshell-cli-environment.ts':
    '77f66ceaffb019038fe06479459505dbb37480b7791c596c8e869bef14c2b456',
  '../openshell-warm-pool.ts': '9af589d6c38ce39d122a9f5d55b5e7c34a977ca6a040918dd7d6fe6321958f5d',
  '../openshell-warm-pool-runtime.ts':
    'f3090664b76b721494f9ef061f89732866d9696ce3c5f6172662c832a88533d4',
  '../openshell-warm-pool-binding.ts':
    '498030ec01afaa475f3e869974ec1eba1465eb537e14c06221e2c217a1e11583',
  '../openshell-warm-pool-router.ts':
    '7736294c00cdf4d20a507c12ec8a60c584d5c43816eae03e261cfbddb9a2690b',
  '../openshell-warm-pool-host.ts':
    '9760df035a16060ed3720ed621ca2d933643dcd3914936f4e54e52a3daf49578',
  '../openshell-lifecycle-service.ts':
    '59ba987486c5cbab33029d6fc14321dca53031c6ae382b0128c3d54b01ace26a',
  '../../frontend/src/pages/SandboxesView.tsx':
    'fb00f863cf2a24cd42ccfd8df6550e40757d392953d973360ee6da530725f08a',
  '../../frontend/src/pages/SandboxesView.css':
    'a130773778bd77fcc144c1ce67d30088d65398a29fd1676906ce99b273bfdd9f',
  '../../frontend/src/types/sandboxes.ts':
    'e0315d28b2b6ecb64cb5fa4249d6dc5c5f705be25e50e2c5e9fa57be591a57ce',
  '../../frontend/src/components/AgentToolsEditor.tsx':
    '4fbf0e9bd1cd4a5f48526e11a5b03949b687bcfb07e0be505fb4e71c94a319fe',
  '../agent-tool-catalog.ts': 'd5df71ee4d2a5f748a8274006642fe88674133315e177f99541e81f7466e3973',
  '../agent-tool-selection.ts': '6ef32b850ba81b4eadd6aded850988e2f29ecc4e5cf64692456447c53ba84105',
  '../../packages/protocol/src/agent-tools.ts':
    'a25c3fcd8a885db213c6528fe9e07fd11da6744304420b4f3affd2e354d1af82',
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
    '8502ebc05d4f36a4f1ee7994790c73f994cb41125e4dc11d9c5196b806920f29',
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
  '../telos-item-tools.ts': '6338abf7d20c0a7ee4f68de4c85e49a75acb8a76545822fba14246d86efe6abf',
  '../telos-mcp-server.ts': '1e062b7718e51b108d246a2aaca729b98d69aa090a05bae2342530a6a0f992de',
  '../../packages/harness/src/tool-tiers.ts':
    'f20dac35032adb67b331d54b3f412bdf6b925b5b19b7990ae383b3fbe4eaaf3a',
  // Approved conversation resources, usage evidence and non-blocking welcome motion.
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
    '0ae0e3288b1d0bea88a1abde8c84b5f782136a0d246743b8bc56ebbddfba7851',
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
  '../web-page-content.ts': '348452aa0875f774d67f8b3b9f65bc793683e0295123e2c63fbb6011e1fbe67c',
  '../request-web-access.ts': '7c3827a0e4ddaf8880b6ec02e1af8bc398b4b064a90bf941570751b859e467af',
  '../web-search-adapters.ts': '37048de3d44f2f3017aab3006c7e2abaf5c6b1c3dda1a624dac9ef9e9b8deb35',
  '../../packages/harness/src/index.ts':
    '847a8c68636cc6cfdaa65b8903180aa179930063bb6828410ff6f66bad9bf1a3',
  '../../packages/harness/src/session-transport.ts':
    '7aaab4c6a3fb5f362b000e7127a8876fb385928d6786145f974ea8ecd4ce283f',
  '../../frontend/src/components/SymposiumConversation.tsx':
    'fa2fcb9f8ad545b181f635a0b442f668e8b6c517cbea83e04eac2d66618321f4',
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
  // Explicit Local draft selection, exact-request delivery and bound conversation controls.
  '../../frontend/src/client-store.ts':
    'e678599c740e0d6c854913d24f769e0ad7e18058341e53e77e0e37479e1ff558',
  '../../frontend/src/components/AccountModelPicker.tsx':
    '9eceb83413e6ae50d00b1aaf4f3fd9547f3289a2ead0acae764df25c3de8c3e3',
  '../../frontend/src/components/ChatAgentProfilePicker.tsx':
    '4e31288412968cd38828169c6f1d17ada0e27d30393758bef86df45542685b62',
  '../../frontend/src/components/ChatExecutionPicker.tsx':
    '09e817e4b6a0b2447c97f8dbad2b1aa9537d0b8958d87819dd5ca7600d219ff6',
  '../../frontend/src/lib/keyboard.ts':
    '1e4c48c258c5e1c73be9f9df03a0491499210b9c24baf2fc6d134de41a9c3008',
  '../../frontend/src/components/ChatInput.tsx':
    'cb2bc49b70f1092be38f9125e312b3968ccd8e2190c9d5d80215d3654673f56a',
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
    'fd5a900f4757836fc06de4ac172d043a3a5397bd79abe22ea7984d9c0c5de389',
  '../../frontend/src/hooks/useNewChatDraft.ts':
    '4791a0f7870378d7353134e2a93972f1f7b5ef8197f20cfdc7304d0fd8adfb75',
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
    'a20c28f87a89d43b1bdff59ba0bf89e8f129c73a24644aba6c3589f16eeaff2c',
  '../../frontend/src/lib/chat-runtime-selection.ts':
    'b47f7b6cc1bd0d261c7c57560204a1e5d18edd72f58e34e7e9fd63eba1244de0',
  '../../frontend/src/lib/explicit-local-chat.ts':
    'c75aa3e02e4c3856d9da573aa9595572a6373101d1090fa441f0d167fa8c0ff1',
  '../../frontend/src/lib/reviewed-outbox-storage.ts':
    'f27a25d30f2890a67aa2b15c7da54ceedc73317aadced7bc2b27371287bbb98c',
  '../../frontend/src/pages/ChatView.tsx':
    '931c85167c038e2f75c6efca6409099b8b6d361b39d9ebcda8188cb14bf3ca91',
  '../../frontend/src/pages/DesktopChatView.tsx':
    '514d1072927e3d25bfe89eaee5d21deba6c5ab0b0c1d733c0814306144f15a8b',
  '../../frontend/src/types/workspace.ts':
    'c54ac596082365496ebf53ca12ce1602b792acfd09092a216285aa69dd38c162',
  '../../packages/client/src/send-outbox.ts':
    '0daa50ad56f8e4dd6318d4315b09b6bb036e2e5208afb222857d64050e399804',

  // Explicit authenticated Local entry, immutable request and shared startup ownership.
  '../../packages/protocol/src/local-codex-first-command.ts':
    'b7dd2d112112aeadabc51d968397e5ddb1806f8130e6207ded0394a863d39865',
  '../ordinary-local-codex-entry.ts':
    'dec6c5c278f967f52c02098a239e851ad71ab6d2fd490bc2ac9165aac5151d4d',
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
    '62db8f7f97febaca0b635068a3b644905ed9cb7431074e3189b7befa3572d537',
  '../ordinary-local-codex-capabilities.ts':
    'bea6fe896ae2956aca4d8b7ec62077ef2d35d0753a94ca78e888a721a26815ea',
  // Owned local command authority and the existing helpers in its code closure.
  '../ordinary-local-codex-host-runtime.ts':
    '5b152f654f029ad43dc1ded3808ea9fe2765b02c753b3a4a414867cbb37e078a',
  '../ordinary-local-codex-selection-owner.ts':
    'da10f385f52f6d9b9cab9ecab392aca246cc6061fe85365c45f27d24a39ad7e3',
  '../ordinary-local-codex-owned-runtime.ts':
    'b54ad0049a72fe5078fb8c1aacb08a762914263e1e7b0b984d8d7f866c5e8ca4',
  '../frozen-host-codex-login.ts':
    'eba897dd3a1d86f6e2567d737980fb74a963a610aade76862222542bd2f81805',
  '../frozen-host-codex-executable.ts':
    '4df86cc1b77d7b4186f9c285bc77fbe1127d16142501d78cf45ea77d628be96f',
  '../frozen-host-codex-bootstrap.ts':
    '81a47639a36d390b3daea6387138d7915408ed60f80df286b27ca9d60b0d48b0',
  '../owned-codex-lifecycle-bridge.ts':
    '784da43bccb37c0ec044ddddfebf547c6d72f94737e32b35378ac761376d0f1c',
  '../owned-local-codex-chat-admission.ts':
    'e2c40e4dc53475bc3b788beeb3f1ba91916e694aab88e2bc44129202345e051c',
  '../codex-account.ts': 'dc2ac5efec915495b6af3c7a3001ea4856427ca2d185648a864d2ceeb6593e71',
  '../codex-runtime-policy.ts': '478f9dc62e9100f01a0fdfbef207cdd02453a4a9a596039e84d70dd94ea85b2b',
  '../model-catalog.ts': 'e6922550fed2f7d6d3330299dfe83726d97d126e79c4a3abdb5e3334020ce90a',
  '../bounded-file-read.ts': '8332b3e5908ebe1464eeb7c99a8963bc402ae1f2d89a979a7495f53d54914070',
  '../session-permission-revision.ts':
    'cf71bb38e2008352cbccfd22aae88f747625a3533c26aad22537d9509c11a26a',
  '../auth.ts': '87920c89768d613ce00f84bf20ab405d95e139d96a168595e7a8c6431d80e963',
  '../native-file-operation.ts': '0bdd92a554e86f5adc56f3607ba053eca7de22281343f97a9e6cc5e6c046f1cc',
  '../sandboxed-command.ts': 'bd8a52ed4a6ad7e8675b345647f111c7dbb1fde5cb6482d4d8dabf6b445622cd',
  // Shared approval scopes, transport custody and provider environment delivery.
  '../../packages/client/src/sse-connection.ts':
    '03fef53de70e3594cb948ac6ecbfe010979043411c658446eb5e2217911a38ce',
  '../../packages/client/src/store.ts':
    'efe6c0da20f366f8c52fe7afe8e82dfc075a2e3c2cfaeadd03933d0cf72d0796',
  '../../packages/harness/src/permission-handler.ts':
    '180a1d3465818e4e53e8184c2ab7ca5fc53b0a267461e9a2fc0291a8a9b09011',
  '../../packages/harness/src/permissions.ts':
    'dc74a2a510e3406e88b45da033717453c03f3cefb19ae37dd961f45b39fd89c0',
  '../../packages/protocol/src/session-approval-scope.ts':
    'ba694fed805637520dfbfdb160f5d8ba8093a76d1cafe70709dbf18a443423d2',
  '../codex-app-server-client.ts':
    'c824905203edea55743c4e3985438eec5ae18fa0a991b18ac86928593e8f97ee',
  '../codex-mcp-tools.ts': 'ad82004d216382a911fbc1f089e4aeb8b22b2e833d6ced51fa6c37682a901206',
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
  '../url-access-tool.ts': '045e01d27a5c5428b9430e440916875a622ea8eb90f598c577d22a2da680a457',
  '../web-access-tool.ts': '0c5e1a8a589cc660983f814abd1994b6b877b1bd1f02b6bc8c26521f6ae1ba13',
  '../index.ts': '46bc46fa2ebd4d485e9ec0addb6cdb6b7d66fc5bc1811e32b3b4e7d8eee43946',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',

  '../chat-rest-handler.ts': '4154270493f9d370f4661c8853f03c8da778effb7858c9b502116786e1908844',
  // Contributor live-query capture and exact output ownership share runtime admission.
  '../query-loop.ts': 'c4b8d036dfd418981cb6e4643143d6b4928645e529ba1bf79fdaaf3840df698c',
  '../account-profiles.ts': 'd3aa20df7e55c236e59fe3a8e7a3bfe40eb390460aa9745c65c718651452cc41',
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
  '../chat.ts': 'b3291bb7c77a59c6d791096abad036752bcbe18c277c7dc642c84367a3972b1f',
  // Contributor execution lifetime is independent of viewer detach/expiry.
  '../../packages/harness/src/session-registry.ts':
    '272bcecc036d39a5763bb942e9050a1c873d39a3fc49a89d7724b6e2bb39a849',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    'f254cadb334bc75dbb19104fdb7ed2b3e46bf2856b81d29300fd4f45db02674e',
  // Read-only session observation is part of the operator route composition.
  '../../packages/protocol/src/runtime-readiness.ts':
    '6be98645eb9b4467c30f5dacb3e8eee7a9c3f08cb6fc820edc872f789ef217c8',
  '../runtime-readiness.ts': 'ea27d8706c0ae6594b78b22436060eded2848b0cd9713e42fa51597928be3766',
  '../session-access.ts': 'feeeea5ffcf16bb1c4542191a74d5eebde2ea2dbcac7cf0e5315d05e2249b1dc',
  // Request authority and physical review composition share runtime admission.
  '../app.ts': '7905a43e4e0541c9066383e81acb17e1c7b3c8477efa094bd424a5a2fc0bdf4d',
  '../auth-check-tracing.ts': '067dc344d8ee76ffe39739a99076f614711ca3d11f96682c842c596a7bbd112e',
  '../telemetry-relay.ts': '302bf6cec2b988ae71a123a5dd04d0f2266a82c3ee51873ec64d8be452c25427',
  '../symposium-review-route-composition.ts':
    'bc2cb2a85517a1f16279fd87757a97b9bb46a16d9efc5f15b52bf41a6f14cae3',
  '../symposium-review-host-contract.ts':
    'bd41408c8dfb9fe4a239fca2e35cf8366bc379e63c4a310d3593cf709a1920d3',
  '../symposium-production-review-composition.ts':
    '5d0e4d78e45cc6d9b3c601cc1f5587c469432bb3ec9edc0c70fb34153dedfc5e',
  '../ws-handler-v2.ts': '2b5f9ced94d2b67a0858d13f04e5db11efba975718c6d7d6a8fdc96a3147115e',
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
  '../codex-conversation.ts': '19ef053de76d46b5d0a6d724bd0a43526722f1468bde19c4d5f65908c72e687d',
  '../codex-conversation-store.ts':
    'a28a891d7e15e599f67b78e9db30fb6b73c24b838b39bd7a86f44d078e6e5d0e',
  // Retained-owner inference cancellation preserves actual handler cleanup and drain.
  '../symposium-custodian-ipc.ts':
    '8dcbf6aefbf29742b2828b7e8ca657aa294e8ee9601f52422ada469fac1731cc',
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
    '2b831e4c18ebc2385118fefb76f415c4b9b5dc656856c453ac36e8f877590a43',
  // Read-only tool catalog cards and their shared visual presentation.
  '../../frontend/src/components/ToolLibraryCatalog.tsx':
    'e287ccd9d36b3def7b49918a955866d8e6466e576742b885b65d7898e03c3037',
  '../../frontend/src/styles/tool-library.css':
    '23c76aa73788e21c161004a3b06a2b413b909a6d03c277a24817f04ea45e0c7d',
  '../../frontend/src/styles/agent-library.css':
    '8470dabf7f2f8e3084dd513815a02b8ce709a6d976e8696bb12da7237f2bea67',

  // Library profile identity, operator ownership and admission are reviewed runtime inputs.
  '../symposium-director-routes.ts':
    '71fa6b5d798815b452b26f7df5c58733abb793222bfa21ec71926b8bba2d8e74',
  '../agent-library-binding.ts': 'e917cecf1c86505c8c420590b2e38e10fb2c8808449f70055e979f9588dc5c87',
  '../agent-library-transport.ts':
    '78976250a5115a432e5787847f7b74fa294b3dd6021a25e4cca0a306a119fc3e',
  '../agent-library-store.ts': 'fac60510d3a4b45aa34777daf885142e067538726104c749f4ebe533861472c7',
  '../agent-library-router.ts': '7905a02837dce7008992136f07b5e92aaec1818ff787e345f4f9febeaa56f520',
  '../agent-library-runtime.ts': 'cc3be2fc2f61053d4430960a2328d41146463fdca701840a92ab65a89b29922d',
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
    '7a20791d08265360c68bd6b94362669e722d06b5bb0d7c95474d0c3b7a702ccd',
  '../credential-connections-router.ts':
    '6d7b779ff5ba148b6aea43483f4003da0d9ed4908e551a273de5906140c7b96b',
  '../credential-connection-tools.ts':
    '40386b5b0555a6dcafff40d16158b95b2372274432344fe9afa6771d67bff57b',
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
    '41d7b35a2306efb9709b53e08deae3971c549101e46d92dd604390018f19c82f',
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
  '../repository-workspaces.ts': '87b74050cf4abf770b164b27d5524b23f2f395bf6adc4bc9bbf977ffd30fdbc5',
  '../../packages/protocol/src/session-metadata-store.ts':
    '0b8cd73207cca8d62405b1de64dabb73da47b4d19b6a83801259b24148e9db9f',
  '../../packages/protocol/src/event-store.ts':
    '2e1899a35d876b578a15886a43d0db4d08687c31934e1201030deece55cba1db',
  '../../packages/protocol/src/session-lifecycle-store.ts':
    '2a219b360a5fbe72b0a550c714bf76a15c6f5969cbbe4251671050257b98e267',
  '../../packages/protocol/src/conversation-replay-store.ts':
    '60ca279c37909d56d842535093f8d8186057a668a1b03a8e53c41f92061da32a',
  '../../packages/protocol/src/execution-ledger.ts':
    'f30d210be1d37f4c61ff47edb1fb3c8dea1dc6fd8d3ea02b6e01310e8d44ffc4',
  '../../packages/protocol/src/session-runtime-binding.ts':
    '074c03124322359a02795c7865a718205f80f8aa9fc6b4e0b5a8f43746d6ca4d',
  '../../packages/protocol/src/types.ts':
    '685aa8614fb75db7d9c3a998718c933f133c314fa719f8a3622d433b2a37e3fc',
  '../repository-workspace-runtime.ts':
    '17120a0d9912245793e79eba7d25768944b132fcdb034f9e545461b15d8b1f45',
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
  '../openshell-runtime.ts': '83fe5f3824fd065a52df78bba9c8be899195eac6fb0dcca2f8e939dbd80edaa6',
  '../codex-chat-session.ts': 'b5fca6c0f8fb923ed2e5b56860c0584c974e2d3eeaa5aceae43fafc4efd6bcff',
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
    'c93b923af1f98e9b526d507e09c34b7806750e06890795b5cfbb6167127ee355',
  '../../packages/client/src/slices/messages.ts':
    '4bed61fceaa9a34613c2c923bbc6e2c74d6dc66ff04d8b897a513d41af66a9e2',
  '../../packages/harness/src/providers/responses-session.ts':
    '8e2db677e8648488c25f50aa74604fd734b694f230ab137436481fb62aacaa74',
  '../../packages/harness/src/providers/session-types.ts':
    '53af4d3c4c3cb3d3e3179ca306689aad6faa03669d9ad62d652e21d18babf8b4',
  '../../packages/protocol/src/agent-context-pack.ts':
    '6964f27523d93a64c153f2d3a56650298a2063521abdafffa0c19c3dba839de5',
  '../../packages/protocol/src/index.ts':
    'eca3cd671b19c6c0a419737b26fbc202fca4d1c41015f4fe99c313ba28223713',
  // Approved Telos workspace wire contracts only; no work/session runtime activation.
  '../../packages/protocol/src/telos-work.ts':
    'e3c01517b0fd4009f7e4b79a05a1d88935cc95aa3c70f4811298487868ffb7ae',
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
    '12ffcdeb10e036a6271a4d887b7a42c4dc903e78227aee0460cf97207a9e871f',
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
  '../telos-artifact-tools.ts': '66400ed107aaf030de5cfade45a87428d883e7a6897a7acd7ff8c959f3a16179',
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
    '788d1cd5acfc01afb62a956b220cef6450c0a23e36c1f7fda1c6fb7b4f35723e',
  '../ordinary-codex-continuation-status.ts':
    '047c367c317b24f64dd346d5deeb67360afa0fdefa3e2ae12e05f52382401a24',
  '../ordinary-openshell-codex-entry-owner.ts':
    '0bac6e9d3bd1d0919a0f7e9d2dc823a53574f41c80ef72cb1e5da5d81ffe5009',
  '../ordinary-openshell-codex-entry.ts':
    '8eb62c8096ea831b3ba5d774c79cf8897dd8e74bbf870091aa159df6cd684eb3',
  '../ordinary-openshell-codex-owned-runtime.ts':
    'e8da21226d10facc3a4b454fedc57e7d7a4de7cb608e7ca2d7a393dd2dfe4428',
  '../ordinary-openshell-codex-route.ts':
    'f0bfd42b4dd663d2577d77ca857fddb9a1ac67d6a894f440b08764b7b33191d2',
  '../owned-openshell-codex-chat-admission.ts':
    '00d4a4f86c3641f68e0a6d1b4ed0240168d350823bb7e88cb380e47dc612cf12',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../session-registry.ts': 'd91b89354926d0ec7355e73fcae4f41066008d63097ca00077f37022fc554ccf',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../approved-url-fetch.ts': '523bbd692e74a9c16b7fd851b6b4b1cdc6be5581e083c04f9549662e11548ee3',
  '../owned-codex-queue-control.ts':
    '00c6dbf8ada1f6da8b519600380470a1a42090e125877b79a6149fd7d9667e9c',
  '../public-web-fetch.ts': '781732b498e47ea120337d98ca96b9c127e78ea93dbb9e0ae6545a858ffe7dac',
  '../ordinary-codex-agent-context.ts':
    'fcf7bc0b5c5942913671ee9c0212b7122d0cdf769ce49806a1047f14158a841c',
  '../ordinary-codex-agent-profile.ts':
    '4b02c2d9e45e7bcd10b23c4e58b37a77e22661d0ce1cdf27de233c4b9979faa5',
  '../native-responses-store.ts':
    '93018dd135459d6e273b9651aaa093ad984ac07c564e54198b6a50b74508f589',
  '../ordinary-local-responses-capabilities.ts':
    'cd24e1f31ced1015908efcd79066289f20f15760098f626403c036f077b3e390',
  '../ordinary-local-responses-owned-runtime.ts':
    '1ff13371c59f59670e9a4d40d26da87d6a01e2efca31a718f859a0b8a0ce8bd8',
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
    '09b59817a6877cb6d28ecd7b3a83169780a5ce39a420c720561cd4106c045f64',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../frontend/src/components/CodexQueueStatus.tsx':
    '9c65fa58fcb830ab14584a50e8589d328ac96591fe2b6e77e076380ca55d6a2b',
  '../ordinary-repository-preparation.ts':
    '2cf559fe9360a8d48e51413bf7f0d7a6b2d2bbfb89dc4675f595a2875216eed0',
  '../ordinary-repository-preparation-authority.ts':
    '4eac6fb91dc7be34a934c52e6fccc537efb1fdd44ea10439e2f0d3920dbbc593',
  '../../frontend/src/components/RepositoryChatPicker.tsx':
    '9cda6bc42392508104fdf72971a8d9351a6f710130128c6b6e6146fe2033b172',
  '../../frontend/src/hooks/useRepositoryChatPreparation.ts':
    '21b62231f1f15b14e874be59d01bd23316f4b7ee516d514500d7599c7c653fde',
  '../../frontend/src/lib/repository-chat-preparation.ts':
    'd800d801ee8cd47bd102381a83e956b6d967db8480a8fa4e3cadc6f880d18786',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../ordinary-command-historical-ack.ts':
    'a5301e8f86add7c8e88cfc39fb091f218645166b4400ebc6169e576bbfef12c9',
  '../../frontend/src/components/RepositoryChatPicker.css':
    '7153c59ed0581a3f69d46a3cd0a0a1f895340d7d6d34d2a360f5380b65f601b1',
  // Ordinary Codex continuation, persistent login revocation and physical custody.
  '../../frontend/src/components/AgentSettingsPicker.css':
    'bd30b16df165a784f34285058165f6e4cb6dd07839da21fe258be8410303d408',
  '../../frontend/src/components/AgentSettingsPicker.tsx':
    '34a3cc605bd76ab3d371bb04b06b6df317f60923d1f23e412a415c354239e595',
  '../../frontend/src/components/UiIcon.tsx':
    '0bda160e1f55b845fd274492144504b76442730729397028db617ef8570b41ab',
  // Responsive controls, bounded reads, authentication recovery and operational observers.
  '../../frontend/src/components/AttentionFeed.tsx':
    'a6439f91736fa6e604bf66638c7127cfcea256137a2ffc8284cf667772965bc4',
  '../../frontend/src/components/NotificationProvider.tsx':
    '5c8e900478b657b157119b52ae8f4325668a8bf96ace930f47de515a068f569f',
  '../../frontend/src/components/ProtectedRoute.tsx':
    '26e43aa23bf531d1a59408817019e9e43c6e12d6594a0bf6342ba63c4d494fd0',
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
    '8da1fb05d820785afec8e7ab671b10ed83b84c67ffff1317d5fd5ce677f2a4c7',
  '../../frontend/src/hooks/useTodoData.ts':
    '2fdf94ff9719384bfbd247218f68a99efa6e243a1560bf287088620a4f12b39d',
  '../../frontend/src/lib/api-fetch.ts':
    '39ae0be32bfda66e5135dbe287eecb5cb5bce0c74d3e823897d6363d040bf9ff',
  '../../frontend/src/lib/api-json-read.ts':
    '60c11f4263ea1e73478e4ff54542968d65c455b36ab9eb3dbb718d02abb94d18',
  '../../frontend/src/lib/auth-check-tracing.ts':
    '7ce7949ea77d373206b90e9cbe59254f4e76df03624eb7c2f0db2936ca79b012',
  '../../frontend/src/lib/biometric.ts':
    'e7689889b995006d0d5f99f757f481fdaf10f70822518d0c46f91c662d45a304',
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
    'bc3c9556216aaea4e4abd405e6bbab9e8158c6d3f7daed51b0d370273ca2c54f',
  '../codex-ordinary-packet.ts': '30dab46fda1ff4daddccf2503bae33bacc3ab1f438c113a102c08854d9d0532a',
  '../collaboration-ordinary-delivery.ts':
    '80ff1b619e945d38883e2cabeb0c8c018c98e2231e5fff629bc742fab95beef3',
  '../collaboration-review-owner.ts':
    'f4d11ddce9221608dbcd45da03a8f23fc9f875741938265d96a16f9c0519f6d1',

  '../collaboration-joining-owner.ts':
    '5bf3fb28f79159e8f124b1216366a9c98e6bc8e3d28d90c11ce3a4a0ed6c7934',

  // Ordinary Agent Builder source validation, durable handoff and user proposal review.
  '../../packages/protocol/src/source-snapshot.ts':
    '7aa1c6b5d5cdb78ef2ab158af74f838f8b7f4b4842a31b622c53bcbcd59fe653',
  '../../packages/protocol/src/agent-library-editable.ts':
    '738b34bf28d24f718609bf2e59c5076d9ef47bb4ce468b91c2561449601b2243',
  '../source-snapshot-context.ts':
    '32ed964e4a9e7d51c2a467d048e9a78ea91154cecd488c69b7f90539612613e7',
  '../codex-rollover-context.ts':
    '4c043831ee4166cd8948b67aa40aa4baeb1a63f307b74385fa8972d4ac67ea01',
  '../../frontend/src/lib/agent-builder-chat.ts':
    '77cf7406897627da216d7c47ef6bfff450f202b19701ed0bab8d4088de7422a1',
  '../../frontend/src/lib/agent-library-working-copy.ts':
    'a01d40fae60598dc66ad61e439e11052cc792c936e0d09507a526d3fbf06eb22',
  '../../frontend/src/components/AgentLibraryChatSource.tsx':
    '721dc65918ffdd5ee977c54220636c3cb1fcf7760b59c13aa49cfbe3f21ecbff',
  '../../frontend/src/components/ContextInjectionDisclosure.tsx':
    'ca4fa6b7bf4e6adc17667d40c845d6ba24ea0e561c9d9a2e12d5e2d1a2e3ea3e',
  '../../frontend/src/components/SymposiumProfileProposals.tsx':
    'bf5711c863811583d484f4776c12bb48f78f15a9f6d8d729d437d2620f2d9e97',

  // Reviewed conversation removal, physical inventory and shared confirmation owners.
  '../session-removal.ts': 'fadb2a3875871808bb898823779ccda1f36a32199389df403f007d56fc937919',
  '../sandbox-inventory.ts': 'c785cab670191e142ef24d819b6e56950c910f7dffbb67613c0c71ac72bca4b9',
  '../../frontend/src/components/SessionRemovalDialog.tsx':
    'a8847d5bc7f3cef2415d1a49d39a8a1763a02723f4ad97588f7b0e21df8dc814',
  '../../frontend/src/components/SessionPanel.tsx':
    '085d90a046cad29225ab3e6ea677652341e1f082a6f4ec13b1c37ac00d9592d0',
  '../../frontend/src/pages/SessionList.tsx':
    '3b9738b0bcae4e4c08793a787a17811e062799c7161faaf976aa02cf2109fd90',
  // S4 ordinary role setup, immutable context, scoped host operations and advisor saves.
  '../task-orchestrator.ts': '76dbcfba80de269d0d5c4228ef58158469f6f1fc4ba6ea3f04cf97656851a549',
  '../telos-work-role-context.ts':
    'a829c634968013320d53e43308478e3b0d07aea5e803d7e31b5c00c112ee77ae',
  '../telos-work-role-host.ts': '29900a5554dc606e55d05a8e2ae40c09def476dc33c4837b2dd734cfe9ffb295',
  '../telos-work-role-review.ts':
    '84167646de503e550876b9c57dc8666485cacedb27da957b2e988d1986583efd',
  '../telos-work-role-setup.ts': '130380c2fdecaba2ec3c7d7d8cc6c073e90a19a4ecad454ce9073ddb839f5a28',
  '../telos-work-advisor-draft.ts':
    'a572995682705f98c47fffbdb11aff5eb0621f08d826e8584db542f8d89a28bb',
  '../../packages/protocol/src/telos-work-role-context.ts':
    'ea9809b17a41366e3f272d39044a1564ac636db1c5016b2b964c118dcd71ae3e',
  '../../packages/protocol/src/telos-work-advisor.ts':
    '6c6453efb49883911a12c494bf85261e21b99d45d5b285248980a85a33b581f5',
  '../../frontend/src/components/TelosRoleSetup.tsx':
    '0a911c0fd1ce944d8c4ed2ca11cb97af919e0487190e017244bcd7cb6760aa4e',
  '../../frontend/src/components/TelosLinkedContext.tsx':
    '5b3347d560bb9456932c7df250583ecc05326147c52e0972c0f0a649c187accf',
  '../../frontend/src/components/TelosItemRoleEntries.tsx':
    'd5cb3a3ccde005cc25050f96c60fbd4f573c18eb00a8ee2a8b131be0bd33eb3d',
  '../../frontend/src/components/TelosAdvisorDraft.tsx':
    '13ce94112aab43de64fb22b139d2508cd30bc02cea5d337bb21d0e89c2c6b1f3',
  '../../frontend/src/hooks/useTelosRoleSetup.ts':
    '0747b5bdc0e4a0f1d524ec025b288f9a2f728a577bf46a8340b00ffc17d6967d',
  // Consented native research, structured URL reads and their transcript projection.
  '../research-instructions.ts': '0847d737a765fd2b1c3707d44909d92b186167b6ab34782ea2deb878dc1488a2',
  '../github-read-summary.ts': 'a0484745af976ccee6b840e3955824509669d0fedb1561d6a6ce35c31ebadc2d',
  '../../frontend/src/components/AgentActivity.tsx':
    '82f33060080e2755cd12ba66b5fccb069284459281b35ff37971e63aba0e0461',
  '../../frontend/src/lib/web-access-outcome.ts':
    '89b884c09d8c7b6b4c236bc4cba6fb4b2a775823e55a893f56241b488f39d803',
  '../../packages/protocol/src/tool-summary.ts':
    '69f553304211b38f926b4f4fe81aeae04b177432ccc0002ab95d3258ef07f90b',
});
