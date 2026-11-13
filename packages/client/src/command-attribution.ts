import type { TranscriptCommandState } from '@mitzo/protocol';
import { messagesReducer, type MessagesState } from './slices/messages.js';

/** Rendering a user bubble is not a prerequisite for steering its command. */
export function activeSteeringCommandId(state: MessagesState): string | undefined {
  const running = Object.entries(state.commandStates ?? {}).filter(
    ([, status]) => status === 'running',
  );
  return running.length === 1 ? running[0][0] : undefined;
}

/** Prefix evidence cannot overwrite a later live terminal notification. */
export function restoreTranscriptCommandStates(
  state: MessagesState,
  commands: readonly TranscriptCommandState[] = [],
): MessagesState {
  return commands.reduce((current, command) => {
    const liveSeq = current.commandStateSequences?.[command.messageId];
    if (liveSeq !== undefined && liveSeq > command.seq) return current;
    return messagesReducer(current, {
      type: 'COMMAND_STATE',
      messageId: command.messageId,
      commandState: command.state,
      seq: command.seq,
    });
  }, state);
}
