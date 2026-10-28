import { migrateLegacyChatDraft } from '../../frontend/src/lib/chat-drafts';
import { chatStorage, initializeChatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createReviewedOutboxStorage } from '../../frontend/src/lib/reviewed-outbox-storage';

const ready = initializeChatStorage();
Object.assign(window, {
  storageFixture: {
    ready,
    async saveNearQuota() {
      await ready;
      const image = { data: 'AAAA'.repeat(35000), mediaType: 'image/png' };
      chatStorage.setItem(
        'quota-draft',
        JSON.stringify({
          text: 'Inspect this screenshot',
          images: [{ ...image, preview: `data:image/png;base64,${image.data}` }],
        }),
      );
      await chatStorage.flush();
      // Keep enough room for a durable reference, but less than this screenshot.
      localStorage.setItem('quota-reserve', 'x'.repeat(4096));
      for (let index = 0; index < 1024; index++) {
        try {
          localStorage.setItem(`quota-fill-${index}`, 'x'.repeat(16384));
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
          break;
        }
      }
      localStorage.removeItem('quota-reserve');
      const entry = {
        scope: 1,
        body: {
          type: 'send',
          sessionId: null,
          clientMsgId: 'quota-command',
          prompt: 'Inspect this screenshot',
          images: [image],
        },
      };
      const raw = JSON.stringify([entry]);
      let quotaName: string | undefined;
      try {
        localStorage.setItem('quota-probe', raw);
      } catch (error) {
        quotaName = (error as Error).name;
      }
      localStorage.removeItem('quota-probe');
      const outbox = createReviewedOutboxStorage(chatStorage, 'https://offline.test/quota/send');
      outbox.setItem('queue', raw);
      await chatStorage.flush();
      return { quotaName, rawLength: raw.length };
    },
    async readNearQuota() {
      await ready;
      const draft = JSON.parse(chatStorage.getItem('quota-draft')!);
      const outbox = createReviewedOutboxStorage(chatStorage, 'https://offline.test/quota/send');
      const [entry] = JSON.parse(outbox.getItem('queue')!);
      return {
        draftText: draft.text,
        prompt: entry.body.prompt,
        sameImage: draft.images[0].data === entry.body.images[0].data,
        imageLength: entry.body.images[0].data.length,
      };
    },
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
