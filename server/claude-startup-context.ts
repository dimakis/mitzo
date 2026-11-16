import { compileProjectInstructions } from './agent-context-compiler.js';
import { prepareHostKnowledge, hostKnowledgeReceipt } from './published-host-knowledge.js';

/** SDK consumer of existing context/publication owners. No source enrollment,
 * account settings, private native-memory access or additional permission system. */
export function createClaudeStartupContext(owners: {
  session: object;
  cwd: string;
  preserveProfile: boolean;
  assertCurrent(signal: AbortSignal): Promise<void>;
}) {
  let prepared: { text: string; knowledge?: string } | undefined;
  return {
    async prepare(signal: AbortSignal) {
      prepared = undefined;
      signal.throwIfAborted();
      await owners.assertCurrent(signal);
      const knowledge = await prepareHostKnowledge(owners.session, owners.preserveProfile, signal);
      const project = owners.preserveProfile
        ? undefined
        : await compileProjectInstructions(owners.cwd, signal);
      await owners.assertCurrent(signal);
      signal.throwIfAborted();
      if (knowledge) hostKnowledgeReceipt(owners.session, knowledge.context);
      prepared = {
        text:
          (project?.context.fullMarkdown
            ? `\n\n# Project instructions\n${project.context.fullMarkdown}`
            : '') + (knowledge ? `\n\n${knowledge.context}` : ''),
        knowledge: knowledge?.context,
      };
    },
    text: () => prepared?.text ?? '',
    assertCurrent() {
      if (!prepared) throw Error('Claude startup context has not been prepared');
      if (prepared.knowledge) hostKnowledgeReceipt(owners.session, prepared.knowledge);
    },
    receipt() {
      if (!prepared) throw Error('Claude startup context has not been prepared');
      return prepared.knowledge
        ? hostKnowledgeReceipt(owners.session, prepared.knowledge)
        : undefined;
    },
  };
}
