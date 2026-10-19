import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TelosChatList } from './TelosChatList';
import { useTelosChatWork } from '../hooks/useTelosChatWork';
import { useTelosChatSetup } from '../hooks/useTelosChatSetup';
import { useTelosChatOpen } from '../hooks/useTelosChatOpen';
import { telosDirectChat } from '../lib/telos-chat-rows';
import { useTelosChatDetails } from '../hooks/useTelosChatDetails';

export function TelosItemChatTab({
  itemId,
  title,
  refreshKey,
}: {
  itemId: string;
  title: string;
  refreshKey: string | number;
}) {
  const [params] = useSearchParams();
  const { work, error, refresh } = useTelosChatWork(itemId, refreshKey);
  const details = useTelosChatDetails(work);
  const setup = useTelosChatSetup(itemId),
    navigation = useTelosChatOpen(itemId);
  const entered = useRef(false);
  const forceList = params.get('chooseChat') === '1';
  useEffect(() => {
    if (!work || forceList || entered.current) return;
    entered.current = true;
    const direct = telosDirectChat(work);
    if (direct) {
      void navigation.open(direct);
    }
  }, [work, forceList, navigation]);
  if (error)
    return (
      <div role="alert">
        {error}
        <button type="button" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  if (!work) return <p role="status">Loading conversations…</p>;
  const role = work.kind === 'work_item' ? 'worker' : work.kind === 'outcome' ? 'lead' : null;
  return (
    <>
      <TelosChatList
        details={details}
        work={work}
        title={title}
        onOpen={(row) => void navigation.open(row)}
        onNewChat={() => setup.configure(role ?? 'advisor', 'additional')}
        onChangeAssignment={role ? () => setup.configure(role, 'assign') : undefined}
      />
      {(setup.error || navigation.error) && <p role="alert">{setup.error || navigation.error}</p>}
    </>
  );
}
