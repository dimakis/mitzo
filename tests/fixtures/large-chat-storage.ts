import { migrateLegacyChatDraft } from '../../frontend/src/lib/chat-drafts';
import { chatStorage, initializeChatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createReviewedOutboxStorage } from '../../frontend/src/lib/reviewed-outbox-storage';

const ready = initializeChatStorage();
Object.assign(window, {
  storageFixture: {
    ready,
    async save() {
      await ready;
      const raw = JSON.stringify({
        text: 'Long message '.repeat(100000),
        images: ['AAAA'.repeat(3 * 1024 * 1024)],
      });
      chatStorage.setItem('mitzo-chat-draft:large-fixture', raw);
      const outbox = createReviewedOutboxStorage(chatStorage, 'https://offline.test/api/chat/send');
      outbox.setItem(
        'queue',
        JSON.stringify([
          {
            scope: 1,
            body: {
              type: 'send',
              sessionId: null,
              clientMsgId: 'large',
              prompt: 'Summarize',
              images: [{ data: 'AAAA'.repeat(3 * 1024 * 1024), mediaType: 'image/png' }],
            },
          },
        ]),
      );
      await chatStorage.flush();
      return {
        length: raw.length,
        diskBytes: localStorage.getItem('mitzo-chat-draft:large-fixture')!.length,
      };
    },
    async failedMigration() {
      await ready;
      chatStorage.setItem('mitzo-draft-new', 'Legacy '.repeat(100000));
      await chatStorage.flush();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (typeof value === 'string' && value.includes('"id":"legacy-new-chat"'))
          throw Error('Synthetic disk failure');
        return original.call(this, value, key);
      };
      try {
        migrateLegacyChatDraft();
        await chatStorage.flush().catch(() => {});
        return localStorage.getItem('mitzo-draft-new')?.startsWith('mitzo-large-chat:');
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    },
    async readLegacy() {
      await ready;
      return chatStorage.getItem('mitzo-draft-new')?.length;
    },
    async read() {
      await ready;
      const draft = JSON.parse(chatStorage.getItem('mitzo-chat-draft:large-fixture')!);
      const outbox = createReviewedOutboxStorage(chatStorage, 'https://offline.test/api/chat/send');
      const entries = JSON.parse(outbox.getItem('queue')!);
      return {
        text: draft.text.length,
        image: draft.images[0].length,
        queuedImage: entries[0].body.images[0].data.length,
      };
    },
  },
});
