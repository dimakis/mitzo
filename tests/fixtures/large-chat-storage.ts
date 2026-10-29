import {
  replaceComposerDraftRevision,
  composerDraftRevisionKey,
} from '../../frontend/src/lib/composer-draft-proof';
import { migrateLegacyChatDraft } from '../../frontend/src/lib/chat-drafts';
import { chatStorage, initializeChatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createIndexedChatDisk } from '../../frontend/src/lib/indexed-chat-disk';
import { createReviewedOutboxStorage } from '../../frontend/src/lib/reviewed-outbox-storage';

const ready = initializeChatStorage();
Object.assign(window, {
  storageFixture: {
    ready,
    async upgradeLegacyPointer() {
      await ready;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('mitzo-chat-payloads', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('payloads', 'readwrite');
        tx.objectStore('payloads').put('old pointer draft', 'legacy-payload');
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      localStorage.setItem('legacy-pointer', 'mitzo-large-chat:v1:legacy-payload');
      await initializeChatStorage();
      const original = chatStorage.getItem('legacy-pointer');
      chatStorage.setItem('legacy-pointer', 'upgraded draft');
      await chatStorage.flush();
      db.close();
      return original;
    },
    async readUpgrade() {
      await ready;
      return {
        value: chatStorage.getItem('legacy-pointer'),
        legacy: localStorage.getItem('legacy-pointer'),
      };
    },
    async rejectOldFrontendEdit() {
      await ready;
      localStorage.setItem('legacy-pointer', 'newer edit from older frontend');
      try {
        chatStorage.setItem('legacy-pointer', 'must not overwrite');
        return false;
      } catch {
        return true;
      }
    },
    async revokedRevision() {
      await ready;
      chatStorage.setItem('revision-checkpoint', 'old-proof');
      await chatStorage.flush();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (value?.value === 'new-proof') throw Error('Selective revision failure');
        return original.call(this, value, key);
      };
      try {
        chatStorage.removeItem('revision-checkpoint');
        chatStorage.setItem('revision-checkpoint', 'new-proof');
        try {
          await chatStorage.flush();
          return false;
        } catch {
          return true;
        }
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    },
    async failedRevocation() {
      await ready;
      chatStorage.setItem('fenced-revision', 'old-proof');
      chatStorage.setItem('fenced-draft', JSON.stringify({ text: 'Same text', updatedAt: 1 }));
      await chatStorage.flush();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (value?.key === 'fenced-revision') throw Error('Both revision writes unavailable');
        return original.call(this, value, key);
      };
      let failed = false;
      try {
        chatStorage.removeItem('fenced-revision');
        chatStorage.setItem('fenced-revision', 'new-proof');
        chatStorage.setItem('fenced-draft', JSON.stringify({ text: 'Same text', updatedAt: 2 }));
        try {
          await chatStorage.flush();
        } catch {
          failed = true;
        }
        return {
          failed,
          proof: chatStorage.getItem('fenced-revision'),
          body: chatStorage.getItem('fenced-draft'),
        };
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    },
    async failedAtomicRevision() {
      await ready;
      const proofKey = composerDraftRevisionKey('atomic-draft');
      chatStorage.setRevision(proofKey, 'old-proof');
      chatStorage.setItem('atomic-draft', 'Original screenshot draft');
      await chatStorage.flush();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (value?.key === proofKey) throw Error('Atomic revision unavailable');
        return original.call(this, value, key);
      };
      let failed = false;
      try {
        if (!replaceComposerDraftRevision('atomic-draft', 'new-proof'))
          throw Error('Expected an asynchronous admission');
        chatStorage.setItem('atomic-draft', 'New screenshot draft');
        try {
          await chatStorage.flush();
        } catch {
          failed = true;
        }
        return { failed, proof: chatStorage.getItem(proofKey) };
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    },
    async readAtomicDraft() {
      await ready;
      return {
        proof: chatStorage.getItem(composerDraftRevisionKey('atomic-draft')),
        body: chatStorage.getItem('atomic-draft'),
      };
    },
    async readFencedDraft() {
      await ready;
      return {
        proof: chatStorage.getItem('fenced-revision'),
        body: chatStorage.getItem('fenced-draft'),
      };
    },
    async pendingMigrationFailure() {
      await ready;
      chatStorage.setItem('migration-source', 'Original');
      await chatStorage.flush();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (value?.key === 'migration-destination') throw Error('Copy unavailable');
        return original.call(this, value, key);
      };
      let failed = false;
      try {
        chatStorage.setItem('migration-source', 'Latest edited draft');
        chatStorage.setItem('migration-destination', chatStorage.getItem('migration-source')!);
        chatStorage.removeItem('migration-source');
        try {
          await chatStorage.flush();
        } catch {
          failed = true;
        }
        return { failed, source: chatStorage.getItem('migration-source') };
      } finally {
        IDBObjectStore.prototype.put = original;
      }
    },
    async readMigration() {
      await ready;
      return {
        source: chatStorage.getItem('migration-source'),
        destination: chatStorage.getItem('migration-destination'),
      };
    },
    async readRevokedRevision() {
      await ready;
      return chatStorage.getItem('revision-checkpoint');
    },
    async saveShared(value: string | null) {
      await ready;
      if (value === null) chatStorage.removeItem('shared-draft');
      else chatStorage.setItem('shared-draft', value);
      await chatStorage.flush();
    },
    async readShared() {
      await ready;
      return chatStorage.getItem('shared-draft');
    },
    async crossTabConflict() {
      await ready;
      const open = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('mitzo-chat-payloads', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const a = createIndexedChatDisk(
        localStorage,
        open,
        () => {},
        () => {},
      );
      const b = createIndexedChatDisk(
        localStorage,
        open,
        () => {},
        () => {},
      );
      await Promise.all([a.ready(), b.ready()]);
      a.setItem('conflict-draft', 'committed A');
      await a.flush();
      b.setItem('conflict-draft', 'unsaved B');
      let rejected = false;
      try {
        await b.flush();
      } catch {
        rejected = true;
      }
      const cold = createIndexedChatDisk(
        localStorage,
        open,
        () => {},
        () => {},
      );
      await cold.ready();
      return {
        rejected,
        durable: cold.getItem('conflict-draft'),
        unsaved: b.getItem('conflict-draft'),
      };
    },
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
      // Exhaust even reference-sized writes, without deleting any existing data.
      localStorage.setItem('legacy-retained-draft', 'Keep my existing draft');
      for (let index = 0; index < 1024; index++) {
        try {
          localStorage.setItem(`quota-fill-${index}`, 'x'.repeat(16384));
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
          break;
        }
      }
      for (const size of [1024, 64, 1]) {
        for (let index = 0; index < 2048; index++) {
          try {
            localStorage.setItem(`fill-${size}-${index}`, 'x'.repeat(size));
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError')
              throw error;
            break;
          }
        }
      }
      let referenceRejected = false;
      try {
        localStorage.setItem('tiny-pointer', 'mitzo-large-chat:v1:reference');
      } catch (error) {
        referenceRejected = error instanceof DOMException && error.name === 'QuotaExceededError';
      }
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
      return {
        quotaName,
        referenceRejected,
        rawLength: raw.length,
        preserved: localStorage.getItem('legacy-retained-draft'),
      };
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
        diskBytes: localStorage.getItem('mitzo-chat-draft:large-fixture')?.length ?? 0,
      };
    },
    async failedMigration() {
      await ready;
      chatStorage.setItem('mitzo-draft-new', 'Legacy '.repeat(100000));
      await chatStorage.flush();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof value.value === 'string' &&
          value.value.includes('"id":"legacy-new-chat"')
        )
          throw Error('Synthetic disk failure');
        return original.call(this, value, key);
      };
      try {
        migrateLegacyChatDraft();
        await chatStorage.flush().catch(() => {});
        return chatStorage.getItem('mitzo-draft-new')?.startsWith('Legacy ');
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
