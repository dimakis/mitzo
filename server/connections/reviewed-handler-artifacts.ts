import { createHash } from 'node:crypto';

/**
 * Bump when a reviewed handler's source contract changes. The build check also
 * verifies the two source artifacts below, so modifying a validator/helper
 * outside a golden input cannot silently retain this implementation revision.
 */
export const reviewedHandlerImplementationRevision = 'v1.0.2';

export const reviewedGithubPublicationImplementationRevision = 'v1.0.10';

/** Runtime admission changes without changing existing provider policy semantics. */
export const reviewedConnectionsRuntimeImplementationRevision =
  'v1.0.659-delayed-tool-result-ownership';

export function reviewedHandlerSourceFingerprint(source: string) {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Generated during an intentional reviewed handler revision. These hash the
 * complete source modules containing compiler/probe/executor semantics, not
 * just fixtures. The build check verifies them on every server build.
 */
export const reviewedHandlerSourceArtifacts = Object.freeze({
  '../../scripts/measure-local-agent-efficiency.mjs':
    'e7cb7e9c7e78ae185fc5608ed58afdbd8d5a0117a2e19ebba0b4ab47d774e66d',
  '../__tests__/wait-for-change.test.ts':
    '8a6354d5ebe1fd0a02d2483b5f5641e18892f5c21a61ceea0f8fbe0ff135177e',
  '../__tests__/local-agent-efficiency-budget.test.ts':
    '292984de9ccc7ef7a5010d891e4e31662a05ab0bf6cb10b72b69f317d63474c3',
  '../__tests__/local-agent-efficiency.test.ts':
    'fa29d3de451cd2b335751c7be3427ff3f924dd41b2aceeeb664c106096468cbb',
  '../wait-for-change.ts': '82cfc955560c5494b9453bfc82e1a14004fc8349f2a5731583791323a03f17a0',
  '../local-agent-efficiency.ts':
    '2bb42e21923250ffe48e075cd387c3a7a8003fb9a906e540860c0dc8b51ece40',
  '../codex-tool-failure.ts': '8f52dfb455bdc1436878a94988c6430e316fc8e6f47df01582b171e7b1ccf0a5',
  '../tool-output-projection.ts':
    'cf73a8155b7912eed21960b4a7d4199eb7fd8e2a0ae68421873f673246ed83b1',
  '../__tests__/integration-tool-discovery.test.ts':
    '5a82a553e7e23759aa2dac0a0c310cb30e57110ac35a3b001547d8e1df5c742b',
  '../integration-tool-discovery.ts':
    '38996219757c68cfea0f8fd59d20d6816f1acfd04dddb49c6f6026774c0027d5',
  '../__tests__/prepared-repository-physical-boundary.test.ts':
    'd63526850338a948cf1e9cd2eadfdb8d5eb4902baec0eaa73ae38b04e7548cd8',
  '../local-repository-preparation-tool.ts':
    'f4f4db06528f0e287397bd45c51952685321e7e4f7e48a1b83062b4f68b5531e',
  '../__tests__/local-repository-preparation-registration.test.ts':
    '0ca706ce8e30e280ce6047bc616e3f663459d9ca5707fbc92c5b682cccb6c09b',
  '../__tests__/native-local-repository-preparation-approval-modes.test.ts':
    '52a067210d22faeef80a8fa7cd45b73f4ebf346e751363ca30401d6813531a6b',
  '../__tests__/native-local-repository-preparation-registration-dispatch.test.ts':
    '8ff8546333b01eb5454b8f73bf0b415f79dcf2e3256aeb08a60c3c2924901c91',
  '../native-local-repository-preparation.ts':
    '9ccc78aa713b57cfcf72e9ac5ab1187362c3370400bdc63060114349f3682d53',
  '../__tests__/native-local-repository-preparation.test.ts':
    '6775351c0f46020825d2fb157a48d973bd1bc58088b92960d4b0c8de7100f1ac',
  '../__tests__/native-local-repository-preparation-custody.test.ts':
    'fa6d25807b24c00ee67e344829223cec70603f3b73c26564b2ea23d78286da81',
  '../__tests__/fixtures/materialized-prepared-repository.ts':
    '4db550b99366022ab922172459a1dad125df059bc1dafc7cf916d1d7fb190deb',
  '../__tests__/fixtures/preparation-attempt-diagnostics.ts':
    '7b91914ab31a83d027f3e6f81dcd7695a49cbc15987d5da42a445f2b41f7a257',
  '../__tests__/fixtures/preparation-service-diagnostics.ts':
    '5fc0428905e5b1a6a75316e2b2e8c7cb563d6c3a63dbf87f9d151e6e34b3d8b5',
  '../__tests__/preparation-attempt-diagnostics.test.ts':
    'db25514e6af83989bac552be67f43c906ef6ccecca21e38ebbd4c63d0d5ce7df',
  '../__tests__/preparation-service-diagnostics.test.ts':
    'f0a1025acdb038cc25a7092b381a4b49838457a7d99e42457e7268ea33220c65',
  '../__tests__/pending-host-task-error-cause.test.ts':
    'bfaf5acdefd35ad40da4fc7905a68e6613a28f172fbeeb4fe47852fe3a7951b2',
  '../prepared-repository-workspace-owner.ts':
    '37b15c26b1eefcfcc721b31e32afc9cfea167ae933d58ec4b796ef101b8e2a07',
  '../__tests__/prepared-repository-workspace-owner.test.ts':
    '17e2ce4a8d505778fec6899ff47e79557bed0be6f71269bb0e92adf9f30ad432',
  '../__tests__/prepared-repository-native-consumer.test.ts':
    '0126e0a7d455c76622c3b67b7a86dfc23d7d697172e48d9ef862fde4cb8c083d',
  '../__tests__/prepared-repository-workspace-owner-sync.test.ts':
    '17b2eec3c51f317450914a1bbd786ecd511c0a6eb5be9a49b10ad7bd2485ddb3',
  '../local-repository-preparation-packed-refs.ts':
    '341c01aae29743c2d2f4b1df97ea466eb2ad939aab4bbf6d719b7e8dab10bdb7',
  '../__tests__/local-repository-preparation-base-current.test.ts':
    'c9f754d4d708befd965bcc8e05456e1899663397d2bc6412ddf30b50e5a7663d',
  '../local-repository-preparation-read-policy.ts':
    '08fe3ddea041f63d7696030d48c640698845439950fe2d0b7343cea6758570c2',
  '../__tests__/local-repository-preparation-read-policy.test.ts':
    '0a6a6ff20d55e51c63acf145f57d34245133f59c18354f07036fdde13e1d9147',
  '../local-repository-preparation-operation.ts':
    '440d15d1865959eb193cec13280c1978f0e5b1013518a49f1d37a8da69913970',
  '../local-repository-preparation-object-data.ts':
    'ad54219d11d65966e2ff3ddd516a0523ebac16e3476435fb30bc1771bad07e00',
  '../__tests__/local-repository-preparation-envelope.test.ts':
    'ab0cb53473ce8cc2c67a35752ad88057d6f61407d1c132f1e00c997c7d72811c',
  '../__tests__/local-repository-preparation-object-data.test.ts':
    'cff939edafcfabca71d756fb86e20a45fc5ccda6ea337fc7be9cd110b95159b6',
  '../__tests__/local-repository-preparation-operation-native.test.ts':
    '04f6b009e6fc3165c5008a862ee773bac0dd0f1d78d42993cb2c8dd851c5f7c6',
  '../__tests__/local-repository-preparation-operation.test.ts':
    '0350713b13d966de6f82fb47cb3cfa4ee6eeae613a50a51c76748084ac9afdce',
  '../__tests__/qualified-local-repository-precopy.test.ts':
    'dd68c7913666f2d68f5da11506be8589b383f3110de2c44cbfb410b555571127',
  '../__tests__/local-repository-read-budget.test.ts':
    'aa7e8429eef1243be920a392e380baad4ace15f684407603da471c25d160b75c',
  '../__tests__/native-file-race.test.ts':
    '7053f0ca654531f087e025b1ae4519dd218fdaa07198c0b41dfcaf85043ee5ce',
  '../native-preparation-publication.ts':
    'e0537b703b06c6cf0fb379a62e510a3ca48d29480ee6710bb9bf34e933dd2a06',
  '../__tests__/native-preparation-publication.test.ts':
    'a5336bb02aba59d1b1d190fe7b18748a1654eaa8170714ce34c098a1a1cd4e4f',
  '../native-preparation-observation.ts':
    'c72eb636f9b9bf76f25c7e2f7d4d0cb1096f304da63f15f8821af45d8cdf4b9d',
  '../local-repository-read-exclusions.ts':
    '33d227b5bebfd0388b161bf369f5d4dbafb4d57b9057e07d945b0deb10394b21',
  '../__tests__/native-preparation-observation.test.ts':
    'eae5a26c4d61233732a9c79ba9483f983d4e728bb2fca03995b2fc69dcab242e',
  '../__tests__/native-exclusive-file-batch.test.ts':
    'b9e2e9c6a1f417b5e524b3c31ae5ef176a92c304730936401350d865e9b10a50',
  '../__tests__/private-helper-deadline.test.ts':
    '6d7d3f12605e45355bce7dcfaca13dc4289190b8cffbd8ca078b54dd92919315',
  '../native-tree-publication.ts':
    '3061106d1ffc562e82329429c261ff1fc3e13056f429c583b7c39743468de15c',
  '../private-repository-checkout.ts':
    'b050a69f85ce16064ac1b462d2f1952990a8f1a411e7ed5027005e28701574d6',
  '../qualified-local-repository-actor.ts':
    '1bbae5d5fbe77b482ffeac2883955874f9f5e54158bf7ddedde2f4eb2a537094',
  '../qualified-local-repository-task.ts':
    '8ce37317250ebe87ba9cb80575ad0050021201b52047d4ab8a6112eb2654c83b',
  '../__tests__/native-exclusive-tree.test.ts':
    '9efadb963a2d87906931063e6fba548e0da02c704555e01469fca20b34af6eee',
  '../__tests__/private-repository-checkout.test.ts':
    'a4858f3f9c76fa52246e2098fb51ed1532ad5d9419097f7f5a373a76c8f57718',
  '../__tests__/qualified-local-repository-materializer.test.ts':
    '7c115aa7893d01938b206f4dd77d0e89fa7ddc7f2c5d56797c855351ff1e9363',
  '../__tests__/qualified-local-repository-operation-owner.test.ts':
    'bb57e28f57cebdb183fcdb0253d86f45eff7a3ab6374e96a13b988c23359de2e',
  '../__tests__/qualified-local-repository-task.test.ts':
    'd887bbb2e911f1bf34b435dbfdd619abfbc06ee10ffc74baa438c6726f53340a',
  '../local-repository-preparation-objects.ts':
    '02db97d5c42f00a89473c451bd22afafc6d7237d756edf8d20644659b8483384',
  '../__tests__/local-repository-preparation-objects.test.ts':
    'd9e6ea2805d88e89a442c6af9dd2ff7df3c682dae44e0512b0a217d288f80f5a',
  '../__tests__/native-exclusive-file.test.ts':
    'b53aeb6f1d3a83790c45393225354ffb4f9923fb243759d57d212f9b5766e124',
  '../__tests__/sandboxed-command-worker.test.ts':
    '9265db1f434d2c14bbc750fa154688637dfba8f03bf0b95e2c1b821caab91efb',
  '../prepared-repository-transition-capture.ts':
    '08be76cbfc8bb74b5c5ba444b953f362463b12875ac679749a583fe2d4aa16f7',
  '../__tests__/prepared-repository-transition-capture.test.ts':
    'd36cec0b9ca51e24dcf962c792451ab0ee75c16a1687f4a6c9cc523c36bf9de7',
  '../__tests__/prepared-repository-candidate-fixture.ts':
    '6cedf991ff72489203464dc01c2b899843229b1743e7711575920dfae8388dff',
  '../qualified-prepared-repository-transition.ts':
    'bc023357b566d6d04cd20c47398d235ccf871453d3a990212bde1e77a63b7026',
  '../__tests__/fixtures/qualified-local-preparation-source.ts':
    '4f6ccfab8961b53534d83db14387ffc0ca72b0c0864c1947498a62357b1bec30',
  '../__tests__/qualified-local-repository-selection.test.ts':
    '110a8a29dbcb68619ccb3f72b8c9c00610429aaa5c2351fac9b8143e3e0188ff',
  '../__tests__/prepared-repository-candidate.test.ts':
    '476c144e828d3a3044efdf41709f9f634755c213dbfebdad67b16fe7e40940cd',
  '../__tests__/local-repository-read-ceiling.test.ts':
    '4a69dd1577ad68e5369c869dca12e62b517ee2d36b9cb9f32e822890e1df49e3',
  '../__tests__/prepared-repository-native-read.test.ts':
    'd05d10fcae21bb3f75614067486bf2e5805045c1e5fff7bf00e522d73a305b8a',
  '../local-repository-allocation-facts.ts':
    '0864cefe22a45e3a69665a2ae4defc417c817bfac3b2c101d99dc09beace5812',
  '../__tests__/local-repository-allocation-facts.test.ts':
    '052c2bfb157ebe02c6b14397e7004ed5b07a40a2cd45d9d80646c5ae350e16f3',
  '../__tests__/native-exclusive-directory.test.ts':
    '9658de84032b1561f32dedc4c819b34a5d2a850b79f92151bc0db440885c13ab',
  '../__tests__/local-repository-domain-read.test.ts':
    '114efb143794b10fe69dfaae07c38d981320dab347a147a2ac2e0a1666422768',
  '../local-repository-native-read.ts':
    'b4da2c70d74dcd79f702223ee214dc416a31ea27102931d71056d837bf183415',
  '../__tests__/native-helper-transport.test.ts':
    '2bc4c7907353b8a13b71d6d7b02dd03f7f0357e2e4878a54e1c62846155adbb9',
  '../__tests__/native-read-anchor-capture.test.ts':
    '9a56e50abf529f0a3551b4ceb61c725ddc58a01fa06a5196364e754dbbf0d815',
  '../__tests__/sandboxed-command-private-output.test.ts':
    'a2169291ec705b7d15341519df8f5f1309e39d46008cbd5962e59efa1236cc6c',
  '../__tests__/local-repository-worktree-facts.test.ts':
    '21e3d764392027039872d0f66c0954bc5be9b843587fdc70ee6642442f2e3c66',
  '../__tests__/local-repository-status-semantics.test.ts':
    '82925f3ea489fc6196f620753bb0503ad5e5c6d3d0e18420ea0d92a47aee5f3e',
  '../local-repository-git-inspection.ts':
    '03679e92fd8a345fa4cf7c9fc67adf414c22b1446e3181e6179fa7977153a996',
  '../__tests__/existing-local-repository-workspaces.test.ts':
    '5f33af94efe047dbac10317ba60e9461e0e7e7d598fabaab5d11eac476669e46',
  '../__tests__/agent-communication-native.test.ts':
    '69203bda9ca703dcead99697ebfc942e7b51f2e5093680739945f2e7de36c028',
  '../session-history-authorization.ts':
    '8c232f932469a9a39c3913b261d968bc051c800125895fbc22805cff44f2a7b8',
  '../session-history-tools.ts': '80fc9d96a0508f9a10b62d01a5db75028c6f6444307b441d895469c64b02f990',
  '../local-repository-discovery.ts':
    '83c7ef8d941aa2f17f33c4cacd7bf9cfe5d1e709371d2e1e2409b86d20e7c810',
  '../session-local-repository-tools.ts':
    '6bfc8f497a442b0f7850448149a60d1da2125fc94b6def5c52660a08523fa076',
  '../__tests__/local-repository-read-scope.test.ts':
    '8beb98baaa9143122b12803270470f06d6dbab393f3870a908438565bb3122f4',
  '../__tests__/session-local-repository-tools.test.ts':
    '1dd52cfc7e24011f14e99ef4928ab71bf0211ba4a88d5d8a12d8ed07bbb7570a',
  '../__tests__/local-repository-read-artifacts.test.ts':
    'e7bced77b25b7f482ee0c6f8cf7373134cf9dde5543dfab7a2ee6c9756db268a',
  '../local-repository-git-snapshot.ts':
    'c112760dae4e91da92112c3dac2176bccb8a09ed3366f1e05cbe61f485dcbee7',
  '../local-repository-read-access.ts':
    'b9b1883e0943f2ef69d4504822d0f2f81374c633296dae7a0c38737aafc8338c',
  '../__tests__/native-anchored-read.test.ts':
    '7322ab8566b3649a90876e253f5d66a8cc631ac7148ee47602c71eaed5123628',
  '../__tests__/local-repository-read-security.test.ts':
    'afc7822c1db6bdad7a99941846d02161fbbb7afb7ed9c8b7bb876b3f4baf4570',
  '../__tests__/local-repository-discovery.test.ts':
    'f88e38685db10c1b24ae187da62fd1d1cf8b19c6b3fcb228f85fc066c107ea5e',
  '../__tests__/local-repository-racy-status.test.ts':
    '9128e4ec7f0921b119f257536550cc8b6ca9cccb33a711a3d15b1058057a28b8',
  '../__tests__/fixtures/local-repository-read-owner.ts':
    '54892e9098eb368d7b31d54498e7ba6c390db333e55dfaa67d1139932c940376',
  '../local-repository-preparation-authorization.ts':
    '642763d6e647e95a84e4743b451778ca546d94dfbeb3e3506b589ecb4d2c4b01',
  '../__tests__/fixtures/local-preparation-native.ts':
    '150b423fc864157c180c3e1dacf61e00044c3c2cfabe5b9d8c7d11a3dc1d4039',
  '../__tests__/local-repository-preparation-authorization.test.ts':
    '3621d87762c222c8500b49b4e89ce5890e6fe6a6945208bbebfe85bcb9f897ee',
  '../__tests__/local-repository-preparation-artifacts.test.ts':
    '996ffbc74d67d01b05c1dea357ad01a9a6155e35596eb77701a13515310a3671',
  '../pending-host-task.ts': '3e14a657d4fd4fb7a5ccfbc35e253c4e6f8017cb1d886d095ff475fe17b8ba43',
  '../__tests__/pending-host-task.test.ts':
    '286badb71f54d57b77e7b57116a566d1772d6c27b520131262ef58551f2ce01d',
  '../__tests__/local-repository-workspace-artifacts.test.ts':
    '903296575fd6d3751d2cc7695659594f6970f44df96b14ed4fa7467601c3de02',
  '../../packages/protocol/src/prepared-repository-transition.ts':
    'c624eeb6fa3e7313b4e314532244b4d1bca27f3b87f96cdccf3cd5e90fa7ffb4',
  '../../packages/protocol/__tests__/prepared-repository-admission.test.ts':
    '8aa81327c18538b02b095723925c1a1c4307f3cf8d8fbe4dbeacff9338b71cc5',
  '../prepared-repository-transition.ts':
    'c301c1915b0ecca42983365e71364589cb20799caba6b4dfa69a05f16ddfe06d',
  '../prepared-repository-barrier-read.ts':
    '9cf246cd92a0af6b2d2f86ba1708caaecb6db1e6213c313b0bacc3752a08d0f8',
  '../owned-prepared-repository-transition.ts':
    '314d8c304878a910dbfb17e7877eb019e536e050a807a0f937731cb1631ccc26',
  '../__tests__/prepared-repository-barrier-read.test.ts':
    'ec51b1508ffd3bb482d849d71697060cbcb43281a0f906757829cd2fee6ce9d4',
  '../__tests__/codex-prepared-repository-boundary.test.ts':
    'dc1152d60df9deb2fc7d7813f7f345619a6dc937baf4078cd4232271ef5abc02',
  '../../packages/harness/__tests__/permission-decision-observation.test.ts':
    '95652995cce184b5a89d022b1e9787e3fa2576af162cf8cab44ca09fc12a84d4',
  '../codex-tool-result.ts': 'a0693aa5a7e0979f7d1c92f7ba138ecafe90c95cf80d18a0be81e92c2d5350f4',
  '../../implementation-evidence/codex-native-macos-permission-kernel-0.160.0.json':
    '50fb0a69a01006e85558cc1cc260338c0a7e8257fab2162191337c66bb11c5b7',
  '../../scripts/qualify-codex-native-permissions.mjs':
    'ca56ac179cfc28efc71e68a4c88d99b323d9f44aa515f11b26109523d515aba8',
  '../__tests__/codex-chat-session.test.ts':
    '023cd95899c7c61a33107a9d81093e0afcb16253469044f298d2d926cb8ff3f1',
  '../__tests__/codex-conversation.test.ts':
    'df4d277a046f88d0bbe021425fe5ac7e369bfeea55ed3f708f8987db2d663cab',
  '../__tests__/codex-native-approvals.test.ts':
    'eb83c138be30ac74ef275eeeb9c5a5c4f43bfbe5a444253a6487e3bee4110238',
  '../__tests__/codex-native-artifact-qualification.test.ts':
    'bf39b31337d0714faac6d73f3b96aa99e8e960f39a54e81f1429699890d7cd05',
  '../__tests__/codex-native-execution-policy.test.ts':
    '02ee31699319568ff124d5702e87312eb71b0a85cc86c8b94bff293e678d55a4',
  '../__tests__/codex-native-execution-receipts.test.ts':
    'e68af02f906ce04a6003719e35a46a471191eeb4e90e155db604dececc1e4df4',
  '../__tests__/codex-native-permission-protocol.test.ts':
    '8e2395429506a4208ff1f59c1ee4bba3e6905ae3a5364961d9aa30aa2b7d1cae',
  '../__tests__/codex-runtime-policy.test.ts':
    'ec742eff2f9d389d2faf43a75457d4797ce1f3e8ff1e068a7db15d2036c0cd16',
  '../__tests__/codex-session-events.test.ts':
    'ba49cbd3ddc9dc6715562d72077115e1d5a37a827ef0fa3f263a68d9cc9f61ab',
  '../__tests__/fixtures/codex-native-permission-protocol-0.160.0.json':
    '3a0d0fdc4c5e61afaa315c0a6d5eaf9f6cc875a34240ceddcef35f1788cc8a4b',
  '../__tests__/owned-local-codex-chat-admission.test.ts':
    '8ff2cab4c488ff4da5bb3cf46b6de9c98edb2d33acdc2aafe449434965592713',
  '../__tests__/owned-local-codex-native-execution.test.ts':
    '0bdb9518e1a704fb6bee5106e6e9fc1706d4ed5e75e88a86528b42ccf1ccb12b',
  '../__tests__/owned-local-codex-native-policy.test.ts':
    '6fcad4b0b9f08df6112df56bf140c1d6327d7f2f4694799e904396648016f47e',
  '../__tests__/owned-local-codex-native-unqualified.test.ts':
    'a472401aa366f081b91fd99d4d52939375076a88365570a2413ad39354a7e762',
  '../codex-native-approvals.ts':
    'a31a328ed22bffdba3901a3186b03abbeb798f5d4683412df2889cef299b98b1',
  '../codex-native-artifact-qualification.ts':
    'cd4f2f9c4913c2e7002a31f8035b0b8c102831d9d380971582344ba46bf86679',
  '../codex-native-execution-policy.ts':
    '6924ba90a2c99f2182f6734820ee3f7f95086b2864ed1b30cfe333c9a74eebcf',
  '../codex-native-grant-fence.ts':
    '2fe5cc62858934be6606446102a151d57cda6ed92dbf24c0b3b3e1dbea99d05b',
  '../codex-native-permission-protocol.ts':
    '9f0090fa908f306c95110e928dc64fd5a7324a7aa3cfed3c1572c8d23bedbf48',
  '../owned-local-codex-native-policy.ts':
    '9eb2e238d49822252d5ecef9ff5d32758b44e42da706cc16d01c0eb24bfe648a',
  '../__tests__/chat-provider-startup-admission.test.ts':
    '2d56b8f9bf1a510324983852152d5d38fd596879ee78dd2b9f9af011139cec4b',
  '../__tests__/connections-credential-readiness.test.ts':
    '9fd63b18aa4c451c051711e3ad1f6602dccb8f01359af84969901de1babb2971',
  '../local-codex-observation.ts':
    '51fb1cc9585a93eaede668ec9e39907abed09504b1cc6bcbbbf5ede9f38e494e',
  '../__tests__/connections-credential-gate.test.ts':
    '553fe22bb02d8458d7e016d6e429c3c8a45d46c245cc2c4b282f394fcf195a02',
  '../credential-operation-gate.ts':
    'cb9c76245fc67059e248a9622ea36192dfac54da98377f66cf5b9112f82601b9',
  '../../frontend/src/lib/constants.ts':
    'cd8ff3b6e0624b6c01652aedba30fa03710fcee433029895eec87c6fa88ec9c3',
  '../../frontend/src/lib/pdf-to-images.ts':
    '5856e80c6cb79e4318766e1e7f515ec2e111fe0a1349e3a82e88d7531de39e92',
  '../host-codex-continuity.ts': 'e35d7bb97c14d57b152630741dd8576d914799e974f50e06d5c54a2eeb614e88',
  '../../packages/protocol/src/ordinary-command-timeouts.ts':
    'ff8b5788ce0d3504d4b0ec497f027a2e1b8e4a1cc0b4f8eb0b5ed8cf9454498a',
  '../ordinary-operator-identity.ts':
    '7c00d29e43314c15c7aab6344cc0711cd357db897285414a1f6761b864f28a56',
  '../ordinary-openshell-default-workspace.ts':
    'e049295ae0d03a90f047cd26a6046f77bc2e408fd31b61b3d8c903e71909ef92',
  '../ipv4-preload.cjs': 'd3b66d61f4d214ba508c78147ecfc6787c245d5c2ca6921bce71fa389eb40b5c',
  '../codex-startup-error.ts': 'd335f78ed2e0e7d414132c7d9f1d7d0db46473580c24abb2fb9e5071c8dabac3',
  '../../frontend/src/components/TelosItemLifecycle.tsx':
    '74cbe49b6b9e66b73de2f7b7492bc23de40f6e31f03b0068bdb5858e79f8e10e',
  '../../frontend/src/components/WorkspaceActionMenu.tsx':
    'fc661a29840de978d76a068169cd7f022fdbbdb9967b494898de94cafc303207',
  '../../frontend/src/hooks/useTelosLifecycle.ts':
    'e470cfd730036151c95a9478a12bfbf1b73b0e66d436f91f2725c1445954c95f',
  '../../frontend/src/lib/telos-collection-view.ts':
    '46f03c12ebbb7fe53faf17adc7923ad8fb42eac9a8f89c0805ebdc9e96496b21',
  '../../frontend/src/lib/telos-outcome-sort.ts':
    '8a6b88fbca7d480a01a99880b375abf181d0bac4360c25c4753b586694348c29',
  '../../frontend/src/lib/todo-lifecycle-events.ts':
    '7ab6ec51e8b4653f58f21f05c50018fc6e0b9bead8285f5931cb20addad24999',
  '../telos-work-lifecycle.ts': 'd43e09df35bc7966aed2645a0d496d38531150ce5606412b651069bed927cbb0',
  '../telos-lifecycle-tree.ts': '4ab02f364793bdfe4dfb64ac66c152d390584c1ce6cd7630cab3af76ed4f6215',
  '../telos-lifecycle-list.ts': 'f2386f34c0c71ae5190458416c8fe056044eb941ab9b2a5a66a43c1407901835',
  '../../packages/protocol/src/telos-work-lifecycle.ts':
    '67db5a5abc859f37eee84a9b3213a41afe4825ddd32f57977492ee67ebb38af6',
  '../openshell-lifecycle.ts': '062e16df43e36c8cba19b5115f8277b4c19cdab3b779dd91cec12578fdb628b2',
  '../legacy-sandbox-deletion.ts':
    '2b102f1158a5c785d0b504c9a40c30284d6b58d579d06b0fba216c6e74aabf1c',
  '../../packages/protocol/src/agent-communication-store.ts':
    '2e817519bf289df59d15f8950862da7572c45b97c0bb4514667e2c95387eb3c8',
  '../../packages/protocol/src/agent-communication.ts':
    '0db8d30742b3ab664708b6a91b5eba2b033979c37c729cad77e598e0418c2409',
  '../../packages/protocol/src/telos-work-controls.ts':
    '1bb5a4acaed5acbe070830a87251929961aaa64e3ec149abd21502e32b0c41b4',
  '../agent-communication-tools.ts':
    '7cc88b8e9fc29d059413ca73cc691b425e6d9c9b4d62782decaa46b6adaece03',
  '../telos-work-control-tools.ts':
    '716f889418970118c872d70c8718f4d268077fedc299f002b72446c205ef3b7d',
  '../telos-work-controls.ts': '684ebfd505612cd01074773b468bd11439909b85da8562ae2c167c0207bddf97',
  '../../frontend/src/components/ChatStatusMessage.css':
    'b2d59e64bcd29465cc2ff0e3458cfb139d663ea5852fc64246a08a7de7830aaa',
  '../../frontend/src/components/ChatStatusMessage.tsx':
    'fc38550628984a03fd5f93299380f44643e518243b1afa32d801919b45a61f78',
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
    'f911d9079af71784f8ca746264ce3fffd84694943722e4c3e7b65872feab7e1c',
  '../ordinary-workspace-artifact-root.ts':
    'c8432fa77fc88b058c0a62a8357d0a816da8ce2d711fe09e6de7e6705fff570c',
  '../../packages/client/src/ordinary-workspace-api.ts':
    'ee09d2edd4bd49a9f65f5e5461127c0587ec64005f45967989c9bc698d45c76d',
  '../../packages/protocol/src/ordinary-workspace-public.ts':
    '2b511851b205a326ddd76a169bac8556bcd829c90e95c073604ab6fa1a8171c2',
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
    'c05a0a914563f181f8afd2378bb30da4b175929149bc9bfe3c3995098cd05c3a',
  '../../packages/protocol/src/ordinary-workspace.ts':
    'c4431b3fef376cf17142c07764c032d0147915893c0b49c1776b0ccccc08c808',
  '../ordinary-workspace-custody.ts':
    '8006d234919812319d845e28dcbdad2f8898ce30f4bc722e5f0ce271a980f3ae',
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
    '329b896ece883b389a84cdfef858283fae8c428c24af8b8f76c2a03910218415',
  '../knowledge-publication-bridge.ts':
    'b4c40483f852a4c0f17dd5fbf9463353a6695bccbdb71adfe94f6b5be5187d94',
  '../../frontend/src/components/AdviserSubscriptions.tsx':
    '568a46de4fc1202e3304220ddb576092882c9a308e5e2080471e89e0bc246466',
  '../chatgpt-plan-adviser.ts': 'b229afb3cb4b9517c58d23d826d7a0445b8c5f5c70fd6115f460793a60a33534',
  '../openai-account-key-authority.ts':
    '7515f2b8ed158a8e81cef4880794a58caa49236623c1c8ee0a977c6693ca6f76',
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
    'd575f127b74ecfdf627cb448d9dc06c47e7497d1842c51fa76c9682af401e6e4',
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
    '698a1276db76272bc56eac4cfd8156870f6f6260479c2ffb216ef276da589405',
  '../../tsconfig.build.json': 'c83304ab66e7691fcf1af562f226581eddfec5765deb9cac309bc9c8c33cfba4',
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
    'f05570232deea0814fd1db0addee83e8155b61375f887f5476ad4ba30abf0571',
  '../collaboration-application-review.ts':
    '620d3455583727da0480f007294d66a2e06e4a727a4df23864d5fbbc0fc06966',
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
    'e0f9accb6ebbd1e7f8b7447e6fb42fcde021af4f6af634f63d6a2613ccd1c470',
  '../collaboration-forwarding.ts':
    '8eb6d7b32dab93b30b92241c9e83b9bd24ef644c38b0648c363847679e2ccdcb',
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
    'd3ac477bdb5261ff0b1e22a8f3a7fd073d06064016188c207c24c7697b9b41b2',
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
  '../codex-session-events.ts': '2041300a52826ad91aa9fb04156a6fe94079143120698dec98e58809f3b75036',
  '../collaboration-context-source.ts':
    '4315a579a1741c55d7c62b9b43fdde35967ad1b6e630eb1d1b5389221cac0995',
  '../../packages/protocol/src/collaboration-visible-source.ts':
    '8747b800cf069cad636dc5ae6e92a347e55b59c9f01fe64af84587e047af1567',
  '../telos-work-conversation.ts':
    '6abc340f3236812d9e9875e8a60944590575d991e95ccaf3f2b61aff323c5175',
  '../telos-work-routes.ts': '26cb4bbedb3cfc31cbd362706a6884f5042fa75435d9907e331053f1f685bf58',
  '../../packages/client/src/telos-work-api.ts':
    '4ac38f1d3482d187658f868abd088250cfa8364652eabdf9334b1035e8eccae9',
  '../telos-work-schema.ts': '99334ce746b53a8c7e79bcd710e94ae0db7df912ab2a7256513cb2679eaacf83',
  '../telos-work-store.ts': 'a244de5bc57c346a7c51fecc41588f97b5c4a7822eb7cd9d47a70396dcf2d6b8',
  '../../packages/protocol/src/telos-work-api.ts':
    'dfed9673113e8f532a253b57ea1696508e339bbfdd83ab98fb2e791a69daf27f',
  '../tool-input-error.ts': '3fa8bc111278d03dd33014cadc8535069c49a12ce636cbbc33126b76190bd3dd',
  '../telos-tool.ts': 'a21d66aaf087d882b78403d335453effa8e7411220d5537b71ff0c271cf9e824',
  '../../frontend/src/lib/browser-crypto.ts':
    '5d10eb99cc0f0d8cbabd7eeefa9ce245bd14c8f32921edbf197a13f4b849b270',
  '../../frontend/src/components/ConversationJoiningReview.tsx':
    '97184120337bd86fdcd0c09384d33a82d31cd6eccc05ca9a3a1dc297564423ba',
  '../../frontend/src/hooks/useConversationJoiningReview.ts':
    'dbd20e6d0be416972288a4454dc0e6eaf771db9c50fcfc1fc4538f407e5b0a54',
  '../../frontend/src/lib/conversation-joining-review.ts':
    '91b857e6e0f5be379cb871543c9181c4c49a3e75c85972bdd00b28ff5ab54890',
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
    'ad099f4b66e624a7baac6963cef7891508797155c059f9d55bc04ef3f11edced',
  '../../frontend/src/components/ConversationAgents.css':
    '780ed8c88c4f1f45a2f5488387a436e7634a3816e0d72a3f5cdd8cd02e111be9',
  '../../frontend/src/components/ComposerResponders.tsx':
    '1d9d03fc824c8903172bc7216dfcdd7bf0275092315b824f583d96410b900c76',
  '../../frontend/src/components/ComposerResponders.css':
    '29b0c05f64bc8555d35a759c7054a950cc70f57a7b49510262ae3b3b1e51f97a',
  '../../frontend/src/components/RetainedConversationComposer.tsx':
    '6be25f820dbf6770f063664ce19429fcfc986547cd8ef397f996a4294b8317d7',
  '../api-schemas.ts': '84b8e0a48c0c246d105afee2be32389156323a75fdd301081c1fc2c542974dac',
  '../connections-store.ts': '0143b2eff9725aed9e2d483087719733174974afd26486eb32d7f9335788c3bb',
  '../collaboration-context-compiler.ts':
    'd52551cd2b7515c93b86acdcba09ca46118d6632c698831e2bc5540dd866e572',
  '../../packages/protocol/src/collaboration-forward-custody.ts':
    '63368fb15184ad9424eb91ef60a6bf8d37fd9ae67a6305eea46cef8e34d56d95',
  '../../packages/protocol/package.json':
    'a61c766103f7c7ba441d67bc52ea1d583e42f57ba8ad1ca2c90d50bdd25fb746',
  '../../packages/protocol/src/collaboration-forward.ts':
    '400794ca0ec65ee75f153787d18ffbf1bdca81f0187959e69fade002b9c18271',
  '../../packages/protocol/src/collaboration-conversation.ts':
    '2dbb2919ab9f5afe75ef015d255808116a38d4b61000eae0793508f78e6cb87d',
  '../../packages/protocol/src/collaboration-conversation-store.ts':
    '0d650294683d000155f3ccb013eb71715c9476457a8667a42bfb800b8ef73d5c',
  '../../packages/client/src/collaboration-api.ts':
    '7f3bf72a97b268a687dab4cd3f6593d510d4e601fc1306504c9bb8e708de5b6c',
  '../../packages/client/src/collaboration-projection.ts':
    'c1c4ba9954434950444389c70be7c1f31460e5fcddc4d99d6edfd74fd113890e',
  '../../packages/client/src/index.ts':
    '8dd54f66ddfae7d465cec98cc1b8c67d604d328998fda97ff87623ca44bedad9',
  '../../frontend/src/components/CollaborationTranscript.tsx':
    '8ee161094085371f18635afe511b37c9020bc6a87d76cf1103e77280bea941ab',
  '../../frontend/src/components/CollaborationTranscript.css':
    'e617da58d37e75e41c4f165ff976675017d4bd650c8949a6b0f2f4fe1634c392',
  '../../frontend/src/hooks/useConversationPresentation.ts':
    'bb3f8e3f54479d60d0306849f63665654f15fb9256310a1b381fd865a64a728c',
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
    '37b50d33f9bd20dafdaf11a27f4134db9e127adfaa7728ceaf5786ac14b1091a',
  '../../frontend/src/pages/SandboxesView.tsx':
    'd9804cbbcf7e42c58f64a37f401101ed347ca8286c8776d82f8220dbd348b95e',
  '../../frontend/src/pages/SandboxesView.css':
    'a130773778bd77fcc144c1ce67d30088d65398a29fd1676906ce99b273bfdd9f',
  '../../frontend/src/types/sandboxes.ts':
    '1f5a4b6bd080363af3a1f77ea246be04894cb9893b0f021353d723658a9f10a7',
  '../../frontend/src/components/AgentToolsEditor.tsx':
    '185739f065ba2ad81534a2b171239d086010447fe03e3669d920dcd13804b5b1',
  '../agent-tool-catalog.ts': '2b9b1126bfb77a4ccd542f1589784f3a3749aa61d455cef3c7d395a827413053',
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
    'aa163fc91d802239f87ada222b962bc40db98aacfe182f30b28b0dda6247880d',
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
    'ba19df25f11d2ddcab34c8e8dfcd7716089a11787e5d8eac4b1be8680c858f05',
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
    '563b9c6529d7d429225585f5f600363899c425df34a358234eb1dfc214cd209b',
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
    '27141b9b6ac9b5d6f6adb36864c89907d7673876320ddbf8565db0510201f19a',
  '../../frontend/src/components/ChatAgentProfilePicker.tsx':
    '7efa0466b67598cf458c3e91b12042f56189747914a85d1040146b2bf6ae7155',
  '../../frontend/src/components/ChatExecutionPicker.tsx':
    '09e817e4b6a0b2447c97f8dbad2b1aa9537d0b8958d87819dd5ca7600d219ff6',
  '../../frontend/src/lib/account-preference.ts':
    '36e668e6435fcc51a648713233a98cc020f05275246f444551140fdc46f3f74c',
  '../../frontend/src/lib/keyboard.ts':
    '1e4c48c258c5e1c73be9f9df03a0491499210b9c24baf2fc6d134de41a9c3008',
  '../../frontend/src/components/ChatInput.tsx':
    '1bf2180fa56c081ea7b91d8eb94b3af38c34a2d5ef353e7e80bc27a2a3f803e7',
  '../../frontend/src/components/ComposerTools.tsx':
    'f939155993b0783c1a231a693de30c13d9594ff558cacc27a23c17a781315245',
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
    'dfca4d38bf1c3c281ea154c169ab570c621635a8a54ab9a99c8c91768b55d584',
  '../../frontend/src/hooks/useNewChatDraft.ts':
    'a4c83772935f35446ac2abb1725b15039c06c10af3493a12ec0d77e7b12bdaf0',
  '../../frontend/src/lib/launch-draft-delivery.ts':
    'd15081e3eb3dd4c2bae69a16d58ac371cfb15cd5d4cc8e39fd20ef90fec0eb47',
  '../../frontend/src/hooks/useDraft.ts':
    '1b98e2c6fcf8864ebf2fb45984b926e2ba9fe21f71aa6368de7545d7dd161b62',
  '../../frontend/src/hooks/usePendingLaunch.ts':
    '2c404fd87c407e7003004e2ed302555c79e4e6487e6f3f1d80c4fff2218599dd',
  '../../frontend/src/hooks/useStageChatLaunch.ts':
    '607b783bd86d52b78df4e814a13df8f1c0c212c6df34a69026379ebee715bc72',
  '../../frontend/src/hooks/useBriefingChat.ts':
    'd0b124d3acf747c6a2605cdf23a7a0bfa59fc87d2aed1d3cd230e440d2c69996',
  '../../frontend/src/lib/chat-drafts.ts':
    '77dc9d88fd08a0e76572ef5df2ad63243f3acf03299c9e917192135038b27bd3',
  '../../frontend/src/lib/chat-runtime-selection.ts':
    'b47f7b6cc1bd0d261c7c57560204a1e5d18edd72f58e34e7e9fd63eba1244de0',
  '../../frontend/src/lib/explicit-local-chat.ts':
    '5bd27d2d4407ff5c4880b982d21c10695bea3613f304fa408ce3bcbc2ed59408',
  '../../frontend/src/lib/reviewed-outbox-storage.ts':
    '89c3593476f8ee0e99ab1ad1f8b0879626e731a8581cf755f5090624cb8ceedd',
  '../../frontend/src/pages/ChatView.tsx':
    '29045bd815e41842473a4af70647b75521c0c009c46bd787b0b3ea6589da2c02',
  '../../frontend/src/pages/DesktopChatView.tsx':
    'c122293a17d2905279070d9c3db8b9a64c5683863875eca8eb5f2871318141d3',
  '../../frontend/src/types/workspace.ts':
    'c54ac596082365496ebf53ca12ce1602b792acfd09092a216285aa69dd38c162',
  '../../packages/client/src/send-outbox.ts':
    'aec96e4e0cc75977f9994fbcc4b1c1bdeb00dda133fd90d056f8f9af4a7ebbd4',
  '../../packages/protocol/src/local-codex-first-command.ts':
    '9e383cf9c96a3cb8ea5bfe732c7ca7c4070cc52c051d80d9d3246fa718a28a0c',
  '../ordinary-local-codex-entry.ts':
    '84fa2540de0d4096479564bd8ffa88e26f669e21b13d21f6cc69c3cea8bf46f4',
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
  '../../packages/protocol/src/default-mitzo-profile.ts':
    'b9575ab1568d635af8aa599df5bfbedc0aac348069e478d1aeeea89270fe012e',
  '../../packages/protocol/src/profile-builder.ts':
    '1f8ac1d7212bff420527b3d51edf4b9b060b08fb4c82280ca6184a4ec6bfe282',
  '../../packages/protocol/src/context-injection.ts':
    'f374381a452c3a5354d9b4e84b21ad3d6d40d10879e43124dec30f40118f60bb',
  '../../packages/protocol/src/ordinary-local-admission.ts':
    '18af1b8b38f43b222afa0e88ad314b607597de26d64abbcaeaafe99d9ae863d2',
  '../send-command.ts': '34845f9e699ef77c245bef3eda73213766c0de962ff75239ee9fccc67f095c22',
  '../ordinary-local-codex-admission.ts':
    '5ead5c41f279abea6efd0ae50c76bd0a966c206b6c64ed4e47f8135687e9b570',
  '../ordinary-local-codex-capabilities.ts':
    '6aa1d7edd2466719bd8766209dd6a6786b37436fc381c672ad4b42e260ad0d03',
  '../ordinary-local-codex-host-runtime.ts':
    '27c89f96f4e59663b4322b013acd6ef528bdb981b55b6b37d5029658b0014a26',
  '../ordinary-local-codex-selection-owner.ts':
    '0939e37fa7d6fb72c8fb122d19104a5fca7ff0f26d78ee408aafc43a919ec15b',
  '../ordinary-local-codex-owned-runtime.ts':
    'fb174028e840062353851a19bac6d8f41a6790e00e63cb0fcbdaf4c98205f39a',
  '../frozen-host-codex-api-login.ts':
    'bb6d0b79308a7ee3b160801d665057d30ed55d33c0dbfbed69bef269d71e0f63',
  '../frozen-host-codex-login.ts':
    'd1f5d8b6fc4f2793f80308918918161206c644300e1f8f6242e5b1cf26620c1a',
  '../frozen-host-codex-executable.ts':
    '1f6bf29d5da1fe3fff90bb6760515d745a189d007c7673981afe7c8485ae6c98',
  '../frozen-host-codex-bootstrap.ts':
    '110f6df04d8688cb63163f1b2ec2974de5c229e61c82a7d077e51b64029d3585',
  '../owned-codex-lifecycle-bridge.ts':
    'b76d973b736e98d2b140b87e0bcd767449539a1bf8fa5f6d41d95e3839408a96',
  '../owned-local-codex-chat-admission.ts':
    'dd7c8195a143307b9f43effb99b6651231162dcf6c61859b113d3fe438163cea',
  '../codex-account.ts': 'dc2ac5efec915495b6af3c7a3001ea4856427ca2d185648a864d2ceeb6593e71',
  '../codex-runtime-policy.ts': 'd11ab33ef4c5c69a5b5d8754ce474afd8a1a712df4b45e93f0690b97636859ab',
  '../model-catalog.ts': 'e6922550fed2f7d6d3330299dfe83726d97d126e79c4a3abdb5e3334020ce90a',
  '../bounded-file-read.ts': '8332b3e5908ebe1464eeb7c99a8963bc402ae1f2d89a979a7495f53d54914070',
  '../session-permission-revision.ts':
    'cf71bb38e2008352cbccfd22aae88f747625a3533c26aad22537d9509c11a26a',
  '../auth.ts': '5486a4a5312d8214d94d981278a08aaf30e3a24c116023d954aa83b010bb0c14',
  '../native-file-operation.ts': 'd01063e0ea7aac69872a632d756db8bd0ee6ce04a24e0b6237bdb3e3294d209f',
  '../sandboxed-command.ts': '089cbaecd209f3f83ecd13334bc25a8c1d797775dd1f65da797e8a659fd70af9',
  '../../packages/client/src/sse-connection.ts':
    '03fef53de70e3594cb948ac6ecbfe010979043411c658446eb5e2217911a38ce',
  '../../packages/client/src/store.ts':
    'eacadd5895597041af784757d16d380a21b6ea75ff90ec2b5c390551fdef6de3',
  '../../packages/harness/src/permission-handler.ts':
    'ded77a1bb6dc8c81ec80ee8a0cafb2691cc90a6b088b12c3559b06a0c7b4b05a',
  '../../packages/harness/src/permissions.ts':
    '546e88401d53f36462c338ec4ac4b4fe86e257cdc39e4f9af44b04989fa05733',
  '../../packages/protocol/src/session-approval-scope.ts':
    'ba694fed805637520dfbfdb160f5d8ba8093a76d1cafe70709dbf18a443423d2',
  '../codex-app-server-client.ts':
    '3990702a536ffda055cf0f122be64350bffa049a02db9afe32706b182440b777',
  '../codex-mcp-tools.ts': '6578dd83d666b9baba516d9bb096dc040ef09acb473e535c42fd69114c698634',
  '../codex-runtime-diagnostics.ts':
    '00b48e32557feff7923a5d548f085d2107383491689ec43f75f465287552f4c9',
  'capabilities/approval.ts': '25c074b3091e67b0c3faba822e8e2c00ff32a34416fe0b37cb4f202d040d0320',
  'capabilities/types.ts': '2d87b1836d4040bb8a887c17d89cc3ccfab213016e6d276cbb3cdc084a0b9a89',
  '../unified-inbox-routes.ts': '3336b45597dd2e6cf209f1a953e90d5e3433b698cb1c686b66a27f7ff0c095d9',
  '../notification-center.ts': '517cbaf2ee73fa178c818f0ea5750e4bab8fc42a503729e9adb2570c06b4304b',
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
  '../index.ts': '7bf4fac7fa8e653f6bee079912b8563ad67663cb8366407d88e96cd237cf20f0',
  '../symposium-app-exit.ts': '6129588f968e7ae2cca592104fc0975081f112c9cfa8ef475c7b12c3a7af7d1d',
  '../legacy-chat-delivery.ts': '30e041a7b8d1279cefae9198639444fa8e3dd4f76386598ec50ce66741f09f5c',
  '../chat-rest-handler.ts': '3e511081210d3ccd59755d28eb9a4d74c91bdac8a4c21a2dd3882080f89e072e',
  '../query-loop.ts': 'fd20ab3f3a85c7e15a38b293816da715fea314d616be25189d6195d653fa2c2a',
  '../account-profiles.ts': 'cbacdf2c442d47190066fb5ec0841454cd6dafdb3b5478d712e0bd520836bb6c',
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
  '../chat.ts': '316c048bfe8f0de1d84508e8baff16ce215ab25649294f65e08e921b2bf58d76',
  '../../packages/harness/src/session-registry.ts':
    'af896f917aca74debf5f02bdbf87904a0037fda31a259d62a047c7b15f3586c8',
  '../agent-context-binding.ts': '4917ff83899105b7ac2c537c8db18111eeb97386d1ca0a2d2b576d872e1db360',
  '../symposium-personal-connection-router.ts':
    'f254cadb334bc75dbb19104fdb7ed2b3e46bf2856b81d29300fd4f45db02674e',
  '../../packages/protocol/src/runtime-readiness.ts':
    '6be98645eb9b4467c30f5dacb3e8eee7a9c3f08cb6fc820edc872f789ef217c8',
  '../runtime-readiness.ts': 'ea27d8706c0ae6594b78b22436060eded2848b0cd9713e42fa51597928be3766',
  '../session-access.ts': 'feeeea5ffcf16bb1c4542191a74d5eebde2ea2dbcac7cf0e5315d05e2249b1dc',
  '../app.ts': 'ee4bffc54c0590c33b6173de030da124952d81cdc4489aec193e9ca2b0c35b9b',
  '../auth-check-tracing.ts': '067dc344d8ee76ffe39739a99076f614711ca3d11f96682c842c596a7bbd112e',
  '../telemetry-relay.ts': '302bf6cec2b988ae71a123a5dd04d0f2266a82c3ee51873ec64d8be452c25427',
  '../symposium-review-route-composition.ts':
    'bc2cb2a85517a1f16279fd87757a97b9bb46a16d9efc5f15b52bf41a6f14cae3',
  '../symposium-review-host-contract.ts':
    'bd41408c8dfb9fe4a239fca2e35cf8366bc379e63c4a310d3593cf709a1920d3',
  '../symposium-production-review-composition.ts':
    '5d0e4d78e45cc6d9b3c601cc1f5587c469432bb3ec9edc0c70fb34153dedfc5e',
  '../ws-handler-v2.ts': '5f2e4073ccbb6572f9b94c18811d8dd5f08f2ef31d26171295c068c23f80da5f',
  '../briefings.ts': '277b26171abc42266a3b621ff7ab10306792764cb55bbc635e41c4ba20e98d49',
  '../home-router.ts': '744708f3503d3ef46114998ce9bb6a68b3068a3c7d57e0c264298cdb69aac982',
  '../notification-store.ts': 'f6b5ec6927c367a94511f6eaf215498ffdb7e76020f417105df81d3812de94f3',
  '../unified-inbox.ts': 'd6d6babc4ca67bc18e23ee1a8d657bb5e1a6d600658573d8159596162f941332',
  '../inbox.ts': '257557567c9a9b4c1ce09fc30bba797d8495b6ef542e101908520dba67e6e56b',
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
  '../codex-conversation.ts': '8c389c95b5fb62cdf9a0ac67f71f8186e7287334576f79ce9f3a111a2d82ea10',
  '../codex-conversation-store.ts':
    'eaf078a2dde4b270a06935a3c46fe3e8c1f8e61ecad7bad72c00ca79f47c5dc0',
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
    '390f1bc77627adac9adb842f70581e0719e0dba500efaf03aad1b3402040bc5e',
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
  '../repository-chat-tools.ts': '4b529b10ac23f679ab932d02df4211064066db21ddd5e0eb4d373ef7343427bc',
  '../repository-task-copy.ts': '0d89600b791719bae79e763eac851a037b6e51c56ae37f52384cf3192a3ac43f',
  '../credential-connection-schema.ts':
    '3489ff131cd0bc28de23d85e1ed7cd4749fcb12f062bdc76407bedc0efe28f47',
  '../credential-verification-error.ts':
    'd4fefb2652ec0bd00b24aac257b31a028b597dc20dd7101c77d527fe4505973d',
  '../credential-setup.ts': '8dfd54d1b4cb4408d52c9ca09f5cc220ba69adf6dc6181bc7de6803fee38f69c',
  '../connection-guide.ts': '9ef03af9ddab350414346f0e0dc61e376007130dc6ae01dd9dadefbeb57c7768',
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
    '5a099e9e372fef0f115cb9ecf7caef26580001edc784534de533782227f3fa39',
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
  '../openai-key-management.ts': '450dec85b8cb0f483a218b2da8e1362f3d7c6c7ec378f95ab6b4727fc52187cd',
  '../openai-key-operation-store.ts':
    '53aa481b64f0b7cbb6055d3d0bd569bb4dc4cd55cf6807748e99a63cc66f20ed',
  '../openai-enrollment-models.ts':
    'e36785249c67f6010bb394ab3856395d1bf341a73a84a88049a86c2ed83d6ed0',
  '../openai-account-enrollment.ts':
    '5af08f875cc12086fcb5ad4b36bf06cfbb43fc724ccc086a7c92c759e20f7667',
  '../openai-account-enrollment-keychain.ts':
    '8bd52d66fc18bb9a573b3602f20eff4fdbdd9194ced1f30246d39584f4076cbe',
  '../openai-provider-enrollment-gateway.ts':
    '55f91240860c2f15d60a9fa491374cf74f30e06a4dbf75ec5ce6f321b9815991',
  '../openshell-key-api.ts': '45164e44c19a0d1c845a847ea3ccae625445d75c3d09fa32ca5ec86dd53e26a3',
  '../openshell-key-api-protocol.ts':
    '3ebca322e76e76771aaffbccabeda9ea1bb2945d672d9f9879d2665b584ca423',
  '../openai-key-gateway.ts': '8469d53784b79310006723b25004cb60ec90d24220961e20c6d7eb1b019e0363',
  '../keychain-rotation-credentials.ts':
    '2fb5dcfc46d720ece0b5fcf25aa892ce9b9d4bca56818ff75a0d87a4754b3802',
  '../keychain-vault.ts': 'ab7815cacdd3e3936bddd862c937f095ce6e27af38ec437b1f47bda84518088c',
  '../keychain-controller.ts': '073f3ef92fa3b12f7c4cb82574f99be3d3e8cfd312a2cc8ca24faa533cbf1d07',
  '../keychain-helper-authority.ts':
    '36f058f1fec64bde110fe930a080b8ecdefc48a27ae8fe0722af4d8f71441692',
  '../../native/keychain-helper/main.swift':
    '316b7aaac1027f7f94d26e093edbe39a3ccac64236bd61702c32c47419f6edb1',
  '../openai-key-controller.ts': '721a1c6a513fc5380e4a2222927cda025bf8cbd7e8d49d8c5d526470e2cff217',
  '../connections-router.ts': 'afb2657c850dd4b3a64cd2d295ca8682204ddcdff0dba90ce6fa610c15596e93',
  '../connections-service.ts': '8f5cedd8b9e2a32616f3ce56d1abb9cf81ad29da8834ebd9c15c3b8470eaf57a',
  '../git-branch.ts': '6dd4fef0069e65d78fc94d047777442e4ef073596555581da536e1e39a5d3877',
  '../github-repository-source.ts':
    '02e1a872e4f24c7fd42ddd4c9a1e535be847f3e1c16ab34593e3511a22003fe5',
  '../worktree.ts': 'e8a7431e47530a804feaea890bb2e679f435d7b7676ee73575d88aca50f6a6b3',
  '../read-only-git.ts': 'b1a5c01474cba24137b3a7eb5bb4dcbd4d593ee0a25230977de6ff272fdbebab',
  '../local-repository-worktree.ts':
    'dfdcb8754a1aee2c41ffa5c677ce97ee2e9bb1231480eb977e1418bc1031fb48',
  '../repository-task-checkout.ts':
    'f7b4440e35924fbcb4d1b5cb5ed20221300e9f33a7328ff308d6c553723453db',
  '../workspace-runtime-private-paths.ts':
    '5839c75aa2e5d325218af40547c28395ec92a56205fd50a023497330aa44811c',
  '../codex-private-path.ts': 'e255500a676397ce84373e4e3876712ac6bf80ffe281c6943a5b8c69fe2c7bcc',
  '../workspace-runtime-client.ts':
    'eb377ad70361797cb34de00c1974952b76cd81041da7668631b138cf5d44473f',
  '../credential-sdk-boundary.ts':
    'a0b2ed52adda81a5ad99ea5544829862df2dd0716ceb5f57d8d3d43512833e46',
  '../sandboxed-command-worker.ts':
    '5a2951153780b0db5b17f0009cf5722948c9872a1b59ea0bf390356e36c01247',
  '../protected-sdk-command.ts': 'e7c59a2ebfd3fde4b0c7c8cdf7f69f9d231e2e5f1819a61e0514cd707bc6c32f',
  '../native-hooks.ts': '8d334e7f2e465ffbb66d4424f09adc04ca4695ce131fbd50d85226ccbf175d16',
  '../hook-bridge.ts': '8885c2b27079799d33958a17942bb7d8953d01540bf7cd4b3ade537ee39c2d12',
  '../native-tool-executor.ts': '67c286127895774cb81c4b5611ff06823cae4670c659b1a39e09355c09ba060a',
  '../repository-workspaces.ts': 'cb670265f4da0aaca608da27460ce05687682a16287be543585d0f92332ad342',
  '../../packages/protocol/src/session-metadata-store.ts':
    '019598b360106c0dd8babc08e9366e40c95c1dd4dca9ea649c37bc7d096b8358',
  '../../packages/protocol/src/event-store.ts':
    '11dbf5ab1d6523295b568539a0585cf48a2d22e0765201e008a797cb2051da73',
  '../../packages/protocol/src/session-lifecycle-store.ts':
    '2a219b360a5fbe72b0a550c714bf76a15c6f5969cbbe4251671050257b98e267',
  '../../packages/protocol/src/conversation-replay-store.ts':
    '60ca279c37909d56d842535093f8d8186057a668a1b03a8e53c41f92061da32a',
  '../../packages/protocol/src/execution-ledger.ts':
    'f30d210be1d37f4c61ff47edb1fb3c8dea1dc6fd8d3ea02b6e01310e8d44ffc4',
  '../../packages/protocol/src/session-runtime-binding.ts':
    '074c03124322359a02795c7865a718205f80f8aa9fc6b4e0b5a8f43746d6ca4d',
  '../../packages/protocol/src/types.ts':
    'c2372bf36f2b869f3b2f0cb1f7bc15c0b24109957f1b1512a3bfe17e4f0fdf7f',
  '../repository-workspace-runtime.ts':
    'e1cb8bcd6240471fb9895121c683d76fee298f9a734c6c9cc34b1417aa4989eb',
  '../repository-workspace-router.ts':
    '3a18eb2f0e7c4057642342179e11a57c205b6651d5e5a94b90d745dd93c3b9ea',
  '../trusted-native-operation.ts':
    '81d1ea0c643053fb6a6f0b740b3767dc0cb2d7f4a1ee6739073923776ba5f918',
  '../repository-chat-startup.ts':
    'd1558d4bac7c350a952939b4933450674d5480fd23c78071b755aa97f7e253d6',
  'runtime-profiles.ts': '3632545ca52fbfad7442de08c03d5f9808b50b5bfdef92f9cd72b8fa8ab5140b',
  '../connections-gateway.ts': '1a664e65926536d102d2fb0d5f4b7cfd7e2631d6d8bf51f2965025cdb87dc64b',
  '../openshell-runtime-policy.ts':
    '9733d55cd1cb15dcf68dd844fd85861bf4fece6f3d46e1926ec9c416dd59d7f2',
  '../task-runtime-guidance.ts': '6e308de61b1579d0cb47a1873b5723c1dda792d8284fcc5abf10752544eb7fec',
  '../knowledge-view.ts': '0582477ca1248067b1c10a97509f0a518343a8aa388f669d8297ef45e87b8559',
  '../openshell-runtime.ts': '3e9734030dea1237f60f274bca7c2a3e68f31ded5d60cca3419df7c84617145f',
  '../codex-admission-preparation.ts':
    '0cb595a8fed20de735d4fa718544baf1a36ccebf3beecc763badd696e4af3098',
  '../codex-chat-session.ts': 'eb1d4fa367222a65e07eb4ccc5a815fce692c22deb78578f5dba36e2efedbbe2',
  '../connections-runtime.ts': '0793e87975e59fc74dc4306802f2633d7d8cd7bca4a42af5bc1a5a2a04c22424',
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
    '1fe34369e723f60e17b1695bfa6002a7c3b0b04a7219d965da7303406f518377',
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
    'd4af752600df810f581266a814e4922cf465c641bcdc369b50e520dd4906e62b',
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
  '../host-codex-custody.ts': 'a9ebb76743bc7d5a1f67d27c879b71816e2efad7c2d60f20277e31f4a19ccc08',
  '../interactive-auth-core.ts': '512e933252bda6a86584dcb3d6a622ddea43d9e525c682dffae91f622e745120',
  '../openshell-codex-custody.ts':
    '7e08950de4b9e31af2aaa87e5bb8eb14a11322e893a4adc363e6c507fe6b323a',
  '../openshell-lifecycle-controller.ts':
    'a064563244ca9757a114b92874f578a3852d32dd4eca30f87142f8212eac5c05',
  '../ordinary-codex-continuation-status.ts':
    '492ab5eb67b177bbac2ad69eede08edff7aa62ce7a6f485d5ee9e9ac12bedcd5',
  '../ordinary-openshell-codex-entry-owner.ts':
    '040d8858f5a05ccc0bc0f369a0ae43e4db7e434e5e15a7b188a8ca9ddefb79e9',
  '../ordinary-openshell-codex-entry.ts':
    'b89f35efbc19c63e91cea06674ed4e55e656cf412f83de120aee45c91438443f',
  '../ordinary-openshell-codex-owned-runtime.ts':
    'b9bbe85f44f3168607b83efd70a8dd75fb56708e81be4c1893e2368d3e7cd199',
  '../ordinary-openshell-codex-route.ts':
    'f0bfd42b4dd663d2577d77ca857fddb9a1ac67d6a894f440b08764b7b33191d2',
  '../owned-openshell-codex-chat-admission.ts':
    '5ed43a1ded24dd0f599aeb914805f6e15842a0be59c44767327ae93a8662b5de',
  '../session-registry.ts': 'd91b89354926d0ec7355e73fcae4f41066008d63097ca00077f37022fc554ccf',
  '../approved-url-fetch.ts': '523bbd692e74a9c16b7fd851b6b4b1cdc6be5581e083c04f9549662e11548ee3',
  '../owned-codex-queue-control.ts':
    '072704806e394d24cf1c5f811738612a5f3cdc0a732a5fa45d13a3ad3457353a',
  '../public-web-fetch.ts': '781732b498e47ea120337d98ca96b9c127e78ea93dbb9e0ae6545a858ffe7dac',
  '../ordinary-codex-agent-context.ts':
    'fcf7bc0b5c5942913671ee9c0212b7122d0cdf769ce49806a1047f14158a841c',
  '../ordinary-codex-agent-profile.ts':
    '7da8530492cf96fc8ae4217408587acaf6c59c8ce87c2d0c87ac66ecd6d0809b',
  '../native-responses-store.ts':
    '93018dd135459d6e273b9651aaa093ad984ac07c564e54198b6a50b74508f589',
  '../ordinary-local-responses-capabilities.ts':
    'a25d1c6ae455a024d02ae95afd777f99dc04b8ab8b1c9a56783f501d87bf0860',
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
  '../ordinary-local-vertex-replay.ts':
    'd7ecdd21c89be167a1b627b024687df00ead20df98c349f51b114d98a8800a75',
  '../ordinary-local-vertex-sdk-query.ts':
    '6556cbacc22a34e1457d37ad1172f66330e7e51cdfa84653e6604a9418281f84',
  '../ordinary-local-vertex-command-owner.ts':
    '7a631c564810af3198bde300697e5ed13c07e9185a85d10e1859c6678919fa5e',
  '../ordinary-local-vertex-capabilities.ts':
    '3b81465942f341640b55ea0f0e34625f1fbb50b36cb5c7abc617c1a751785cfd',
  '../ordinary-local-vertex-queue.ts':
    'a3cd6f4b1785ca8401c5c6e728e32ec531c6e0263aae9daff5643515912b59d1',
  '../ordinary-local-vertex-sdk-process.ts':
    'fb9323a7fe3a55d6998dd70e0b6e16ff5f008ecb763bc8da9777b7f24514a30e',
  '../../packages/protocol/src/ordinary-local-vertex-admission.ts':
    '586662f9bfa8fef23bbc2910412aa1285b45f698c1746f14794771ca5bfb9d3a',
  '../../packages/protocol/src/ordinary-local-vertex-custody.ts':
    'f118a9a47afcb9bf2683cffd631afb5b19bc230f1dbbb12d6309c1555f412c70',
  '../../packages/protocol/src/local-vertex-command.ts':
    '68c894b50473dff78d3c82ebab11d27b5f937a76a9b972248d1327b9e6b54d97',
  '../../frontend/src/lib/chat-runtime-route.ts':
    '67200a639105f220125f90c9704360a272d09c01af6731ff4e8a29b929c03361',
  '../../frontend/src/components/ShareButton.tsx':
    '3f43fa3098cd0fd83b80bab6c42877ccfddeeef80b9ab0a8ec4e058240a94411',
  '../../frontend/src/components/CodexQueueStatus.tsx':
    '5017c336dba0dc7e4d95d2e57af46d13d808be0bb8b22710919edd345003df78',
  '../ordinary-repository-preparation.ts':
    'c9d0113da17201ee421c4bdadb9108ae6817460ffab82cdb6eb4de888ecb0d9e',
  '../ordinary-repository-preparation-authority.ts':
    '9252ab3b59dc650ce58f5c20fd05d435ba8652622d6e8d5c5e1b444ff9047fae',
  '../../frontend/src/components/RepositoryChatPicker.tsx':
    '1b67d8ac02bfe47ed49b404e8733b7a28b0a81be71cc2a6ef85a640863d794f1',
  '../../frontend/src/hooks/useRepositoryChatPreparation.ts':
    '21b62231f1f15b14e874be59d01bd23316f4b7ee516d514500d7599c7c653fde',
  '../../frontend/src/lib/repository-chat-preparation.ts':
    'ac1c621aa445c844ecc18e04c106f3cd2e414a8ca4f9115183e6bc32e6d42c98',
  '../ordinary-command-historical-ack.ts':
    'eac764b9c786250a8e911a9e9b4d0f1d2ed343286d718152590672a98dd6ee2a',
  '../../frontend/src/components/RepositoryChatPicker.css':
    '900f02aff92df6eb1ad5ad7e3abfb56ae268a3dc20f28798d5170a8c61044928',
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
    'a5361395b1267276ae7b2352c46d24263a42029c5df7b507674249ddaf1f1ed8',
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
    '9e57700bb40318954b0c2efbb0ee8f81541e22146b8dbfbbae422b6e2503e0d2',
  '../../packages/protocol/src/ordinary-prepared-session.ts':
    'fc4d953515c7df9cf7594b4fc502c39d891cdf53c667a3db6839c390effa20e3',
  '../codex-ordinary-packet.ts': 'a1368ea052869a5c1a16b6caeda9b785bfca4b8af649ce756e0e76fbafba353a',
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
    'f53f3ca6ab723252b43102e5fd897153653f624626d8113fb2986613708fd600',
  '../../frontend/src/lib/agent-library-working-copy.ts':
    'a01d40fae60598dc66ad61e439e11052cc792c936e0d09507a526d3fbf06eb22',
  '../../frontend/src/components/AgentLibraryChatSource.tsx':
    '721dc65918ffdd5ee977c54220636c3cb1fcf7760b59c13aa49cfbe3f21ecbff',
  '../../frontend/src/components/ContextInjectionDisclosure.tsx':
    'ca4fa6b7bf4e6adc17667d40c845d6ba24ea0e561c9d9a2e12d5e2d1a2e3ea3e',
  '../../frontend/src/components/SymposiumProfileProposals.tsx':
    'cdbfd4a2f27bc548cca872b616f1a2d0f1bac021a4dec95a0e24d87a3ea864ca',
  '../session-removal.ts': '49de9ed4b03f62a9582896e5ac8e5ba43292c73e66b1c2c6e4a10244a7065e05',
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
  '../research-instructions.ts': '43b6b28df80b4b1e306619c7089c5e3e1326cfc97253f810a1732ce67bf9c082',
  '../github-read-summary.ts': 'a0484745af976ccee6b840e3955824509669d0fedb1561d6a6ce35c31ebadc2d',
  '../../frontend/src/components/AgentActivity.tsx':
    '6dace0ce097e4c7647a14134f3d75e0d2e76650da4a222ea1e117c7bf04178a0',
  '../../frontend/src/lib/web-access-outcome.ts':
    '89b884c09d8c7b6b4c236bc4cba6fb4b2a775823e55a893f56241b488f39d803',
  '../../packages/protocol/src/tool-summary.ts':
    '69f553304211b38f926b4f4fe81aeae04b177432ccc0002ab95d3258ef07f90b',
  '../openshell-lifecycle-production.ts':
    'be9cc11789bfc0faa9338bf5e4b3552510ea0f5a3ca54a029903bf96aa1b0f81',
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
    'e7038bb5dabb8d33874a8ba7d84052283ab693fb42c9eb200d3211f541de3f5f',
  '../../frontend/src/components/TelosWorkspace.css':
    '91941ae1629095e25c622fe1ca42dd8f41e46a6be1d3fd56a7fa427b40997b34',
  '../../frontend/src/components/TelosItemWorkspace.tsx':
    'c2117a64646a5e141366e75e64a39209254588f7749911f6dbe950085d10018f',
  '../../frontend/src/components/TelosOutcomesTree.tsx':
    'f70577094f74e2e5076c4dafa5ee3b8737d7d5f3181b37d810a3d4772291f1e2',
  '../../frontend/src/pages/TodoWorkspace.tsx':
    '4ef4ba56945500aa99e4cfb550b7c059a33406f532a1e6ad89a006fadae618d3',
  '../../frontend/src/pages/FileViewer.tsx':
    '9b8b8637790030d943979c66e8788af95a7e488122fe15bb9cad4e29c0b2fc80',
  '../../frontend/src/components/TelosChatFrame.tsx':
    '3264d9f5eb462995b7901fe81e8fd9dc34107af5ca2e4c672c606704c26a9f0d',
  '../../frontend/src/components/TelosChatList.tsx':
    '488b027baa3f9fe8dd8ca6126966004ff2a560b1a8a06a570b685e476e93defe',
  '../../frontend/src/components/TelosWorkControls.tsx':
    '4caf0cc099bd2a29dcf0b6e3a6e17c55823e0e5765b738a5306c859686641d44',
  '../../frontend/src/hooks/useTelosChatDetails.ts':
    'f1b2e94eb37468ed215e2c4f9045f67c8d6acda4e8814c66d7938b38e51232d3',
  '../../frontend/src/hooks/useTelosChatRoute.ts':
    'ec6615ec65d49692c418be6ef5ec7249290dc11f72ccf61a7768bd35b83bde36',
  '../../frontend/src/hooks/useTelosChatWork.ts':
    '1daa58043c0b6f2bd837378b9c120de884381683dd9e4e680d5003c46d6ee62c',
  '../../frontend/src/hooks/useTelosWorkControls.ts':
    '11717e8a9bb48342f3c1c67fc46cb0d2cd85fa41525bdff367f337996fe26262',
  '../../frontend/src/lib/telos-chat-return.ts':
    '82a93d73cc17247366037d16e0909473fbbb8f64b73a1730f1456bbadf701077',
  '../../frontend/src/lib/telos-chat-rows.ts':
    'c7a31faa96b46c2992baadb43e06f968cdac9e54e19957ceb7372b9afca9ebe8',
  '../../frontend/src/lib/telos-chat-tree-context.ts':
    'd00c462c170663a8868eb29157e9e512c5672473cb0db9ab7611a87794a298bd',
  '../../frontend/src/lib/telos-item-navigation.ts':
    'da0d9a3b1ad1a525317aa406f5a2346d3ea52da8ec7282caf84b14a63d57dbe9',
  '../../frontend/src/lib/telos-work-entry-role.ts':
    '1116a555e86fbd95a99c4addd1d00c55480928d4d277d9c33bb11e7b430465af',
  '../chat-event-stream.ts': 'a77fdefdccda2b8bb2c5e3c53d84c161cf145d43e3e014db1083ec40cf891037',
  '../native-host-tool-context.ts':
    '588067a924ac32a1b56b29edff05e8fd23c35451b1ee8b8d70ebafe82af4445e',
  '../symposium-publication-credentials.ts':
    'e1c578eec9297cf567c6ef31ac3443ad8a36a3fb40ccda2149ac18d18362346d',
  '../openshell-artifact-reader.ts':
    '8fca47739ca0c207647dc825ee468aa86da4379b2004905669b7dd42f100ea13',
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
    '54659199fbb1fa9f61705435512ac1b3a30969df3f37a149fe551db3c6c7dbab',
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
  '../task-mcp-selection.ts': 'f57bc9e25a6ecbe8272f9bbd4c9cb1adbceba27353c48aae7485256d404be937',
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
  '../__tests__/local-repository-preparation-references.test.ts':
    '276cbbb4484e789bb449af2b725e338b0dcfd3676d3f9a203a2f4bb22b0c66ce',
  '../local-repository-preparation-source.ts':
    '364573314e31734cc858dd28501bd17272785c059d03084ea098c601e345d927',
  '../__tests__/local-repository-preparation-source.test.ts':
    '46657283e4005adf0ee4fc38ea42fd51c29cf0d31f0707006049626e5bb829dc',
  '../__tests__/local-repository-reference-metadata.test.ts':
    '23ea66a0970bc2280c10aa856016c9b52b17cbeb5241901f9c67d8225a23c7ff',
  '../__tests__/local-repository-cached-stat.test.ts':
    '9997545be8bb48fefbeb7420574c3cb926426b37c407328240f680709e472f99',
  '../__tests__/local-repository-verification.test.ts':
    '1206bb0184568552af250d07bc70fbc2492ffd97f1070455f2800622a1007800',
  '../__tests__/native-directory-verification-batch.test.ts':
    'e47f7310524224a555e8786f83824f4f742f5838f5666a461e95a5b99ec647fa',
  '../__tests__/prepared-repository-custody.test.ts':
    'ecb52ddbba239c2e8d52a2cca6579e2671db689080c9c81168a563b864b56089',
  '../__tests__/native-host-read-owner.test.ts':
    '7eeb0b94edcd36a2e80488c242d3ebc7bd3606c1e71ae5f2f4f7100919c5bf8d',
  '../__tests__/session-create-runtime-selection.test.ts':
    'c5de4a6560ec62a86487d599dc7fbf981daa0455407933d2bcf3a7ece9250332',
  '../account-harness-connection.ts':
    '81a0d896c70cd660a44f4e3ca7506d1fe52f501cde8d2776dbd6f50d77532316',
  '../../frontend/src/lib/briefing-registration.ts':
    'fbeb3c766c9ca38ad9dcad04f245c0db6bca4d269775e1e32f9392ba3ab15c46',
  '../../frontend/src/lib/__tests__/chat-runtime-route.test.ts':
    '7b60a8b59f573a248d21dcca15275335746829a3a46791b152266c2d40b594b5',
  '../__tests__/ordinary-local-responses-chat.test.ts':
    '6f008d8414db13b962799ed0063411c12ad0d7fc1041d4873c6e3cce9bb22816',
  '../__tests__/ordinary-local-responses-dual-capabilities.test.ts':
    'a1beb878190e4982b74b5b20941b6c47373736986a729ba9398764a78b602f3e',
  '../__tests__/ordinary-local-responses-preparation.test.ts':
    '8f9c5d3b3ba18d05a4319769d731ece393fb2485035b7feac239f876c4c2695e',
  '../__tests__/session-harness-routing.test.ts':
    '5e3b0dc001073ace7fdce64f032615246b3f814be03678ecee0d0010d569bdb1',
  '../ordinary-session-runtime.ts':
    '52605bef96fa9d52857f7a5d6436a2fedd74d93e289b4136f193c405094d582c',
  '../session-harness-routing.ts':
    'fd3a046c0969f1f185e3331b23a00ded64ac5042bca07dff5f3c5399edb0f842',
  '../unselected-headless-session.ts':
    'aa53554be7c2dbc71044d0f8cdf461a9e4c521713142a6fae719f484c41ac7b1',
  '../__tests__/unselected-headless-session.test.ts':
    'e5138c11cc0a532dd3e1aa875f46ab77beb1ce55f90231e10ca27af0165b2bc8',
  '../../frontend/src/hooks/__tests__/useExplicitLocalChat.test.tsx':
    'a11a7f10a047e4262c805920b5181c1672b84de3e82e6c933ce6a331ccab1883',
  '../../frontend/src/hooks/__tests__/useExplicitLocalChat.ordinary.test.tsx':
    '1450992dce892b6878fc16123c5d658289924dce6cec3f199da2f7d05bbe93b7',
  '../../frontend/src/test-utils/multi-runtime-inventory-fixture.ts':
    'f5390008c0d7e953d2531f61d8a8cbfcc9d9f329923b23ffa1c1f4df95b4db1f',
  '../../tests/offline/builtin-agent-picker.spec.ts':
    '4700e76f662392bcf45a62d6986f15b3f30aaa7043834a2eab320acb3531b14b',
  '../../tests/offline/multi-runtime-picker.spec.ts':
    '6d900590ed6f69ce3568e70c07be2689a8e329085745d03e5583e5fc7400e235',
  '../../tests/offline/repository-preparation-recovery.spec.ts':
    'a93d05aeebcb63d47f6ee9c140fce57c78e3383f652a5f896d9e0e1124f76cf9',
  '../__tests__/ordinary-repository-preparation-api.test.ts':
    '94675d6da221ea9eb96d5208d81ee78c1c22ebfff00025728252220ef7253bb0',
  '../command-timing-trace.ts': 'f4c8ddbcae082c29fd718f09dd4b846b5aacc25574f43d681e31a508bae76560',
  '../__tests__/command-timing-trace.test.ts':
    '65f51c783408f255dce89aa221ff33b0f45f51eb8c906f858cb61fc99f1f0a80',
  '../__tests__/prompt-trace-timing.test.ts':
    'e5ac6f87bfd69c1e788304b274cd7b25768869099361dc4e69d0e35c535bf6c1',
  '../__tests__/prompt-trace-timing.e2e.test.ts':
    '751a6e2763c3a6affca6a03ccaa76e7e70971f40fced7a4535eaf01f3f0fe504',
  '../__tests__/fixtures/prompt-trace-timing.ts':
    '7f6af8c9c7d623f8cdcb2e7bbe21a5d5d31f4ad94a6faca86dc25817e6904e8d',
  '../../scripts/validate-prompt-timing.ts':
    'f54835f8968317c8b580caaee95effbed91e84d667b3003b31215e3a97159063',
  '../__tests__/local-repository-metadata-directory-batch.test.ts':
    '52d0953d6d2e1e07fcaa6dd292d63d632e1a406b61a6b723a45af149dada45ed',
  '../__tests__/local-repository-initial-directory-batch.test.ts':
    '0b4359329a52ff0878bef702eb3748cab2288502fbe6f55ed68c2b57040e95e1',
  '../__tests__/fixtures/local-repository-native-tools.ts':
    '7823a1694011217e191bb52716c8176dc34a51ddad39a3825b2703dcf5f8fcc1',
  '../__tests__/native-local-repository-read-projection.test.ts':
    'e78286f66f12951fd228c86e7044e17d3e5023294087aa0b4b16ec0b6af44571',
  '../__tests__/native-local-repository-read-registration.test.ts':
    'b628ecd466b1f7b28c5c77f7dcd1751629f9318be5d1b4f472663db272f5cf8c',
  '../__tests__/native-local-repository-read-tools.test.ts':
    'a75414d44906ede0855d2bc592f738081f171ed22ba8aaf5b23560118f82d4fd',
});
