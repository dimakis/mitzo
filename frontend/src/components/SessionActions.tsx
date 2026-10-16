import { useState } from 'react';
import type { Session } from '../types/chat';
import { useConversationPins } from '../hooks/useConversationPins';
import { copyToClipboard } from '../lib/clipboard';
import { HomePinButton } from './HomePinButton';
import { UiIcon } from './UiIcon';
import { recordTitle } from '../lib/record-title';
export interface SessionActionsProps {
  session: Session;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose?: () => void;
  menu?: boolean;
  onDetails?: () => void;
}
export function SessionActions({
  session,
  onOpen,
  onRename,
  onDelete,
  onClose,
  menu = false,
  onDetails,
}: SessionActionsProps) {
  const pins = useConversationPins();
  const [copyStatus, setCopyStatus] = useState('');
  const pinned = pins.pins.some((pin) => pin.id === session.id);
  const role = menu ? 'menuitem' : undefined;
  return (
    <div className="session-actions">
      <button type="button" role={role} onClick={onOpen}>
        <UiIcon name="chats" />
        Open conversation
      </button>
      <button
        type="button"
        role={role}
        onClick={() => {
          if (pins.toggle(session)) onClose?.();
        }}
      >
        <UiIcon name="pin" />
        {pinned ? 'Unpin conversation' : 'Pin conversation'}
      </button>
      <button type="button" role={role} onClick={onRename}>
        <UiIcon name="edit" />
        Rename
      </button>
      <HomePinButton
        pin={{
          kind: 'session',
          id: session.id,
          title: recordTitle(session.summary || 'Untitled conversation'),
        }}
        variant="menu"
        menuItem={menu}
      />
      <button
        type="button"
        role={role}
        onClick={async () => {
          setCopyStatus(
            (await copyToClipboard(session.id)) ? 'Session ID copied' : 'Couldn’t copy session ID.',
          );
        }}
      >
        <UiIcon name="copy" />
        Copy session ID
      </button>
      {onDetails && (
        <button type="button" role={role} onClick={onDetails}>
          <UiIcon name="file" />
          Session details
        </button>
      )}
      {copyStatus && <p role="status">{copyStatus}</p>}
      {pins.error && <p role="alert">{pins.error}</p>}
      <button type="button" role={role} className="session-preview-delete" onClick={onDelete}>
        <UiIcon name="trash" />
        Delete conversation
      </button>
    </div>
  );
}
