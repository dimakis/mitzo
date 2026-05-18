# BootContextPill UX Fixes

**Telos:** ae582634f14580e5  
**Status:** Not started  
**Date:** 2026-05-18

## Issues

### 1. Pill Disappears as Agent Replies

**Problem:** The pill scrolls out of view as messages arrive, making boot context details inaccessible during long conversations.

**Root cause:** `BootContextPill` is rendered inside the scrollable `.chat-messages` container (`ChatArea.tsx:155`). No sticky positioning.

**Fix options:**

**Option A: position: sticky (recommended)**

```css
/* global.css */
.boot-context-pill {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg-primary);
}
```

**Option B: Move outside scroll container**

```tsx
// ChatArea.tsx
<div className="chat-area">
  {bootContext && <BootContextPill context={bootContext} />}
  <div className="chat-messages" ref={scrollRef}>
    {/* messages, no pill */}
  </div>
</div>
```

**Recommendation:** Option A is less invasive.

---

### 2. No Modal Pop-Out for Full Markdown

**Problem:** Tapping the pill header only expands inline. No way to view the full compiled markdown sent to the model.

**Solution:**

1. **Add modal state:**

```tsx
const [showModal, setShowModal] = useState(false);
```

2. **Add button to header:**

```tsx
<button
  className="boot-context-pill-view-full"
  onClick={(e) => {
    e.stopPropagation();
    setShowModal(true);
  }}
  title="View full markdown"
>
  ⎘
</button>
```

3. **Render modal:**

```tsx
{
  showModal && (
    <div className="boot-context-modal-overlay" onClick={() => setShowModal(false)}>
      <div className="boot-context-modal" onClick={(e) => e.stopPropagation()}>
        <div className="boot-context-modal-header">
          <h3>Boot Context (Full Markdown)</h3>
          <button onClick={() => setShowModal(false)}>✕</button>
        </div>
        <pre className="boot-context-modal-content">{context.fullMarkdown}</pre>
      </div>
    </div>
  );
}
```

4. **Protocol change:** Add `fullMarkdown?: string` to `BootContextMeta` (server already has compiled markdown from ContexGin).

---

## Files Involved

- `frontend/src/components/ChatArea.tsx:155` — render location
- `frontend/src/components/BootContextPill.tsx:40-111` — component logic
- `frontend/src/styles/global.css:1645,2396` — styles
- `packages/client/src/slices/messages.ts:39-47` — `BootContextMeta` type
- `packages/protocol/src/ws-schemas-v2.ts` — protocol schema
- `server/chat.ts:764-780` — boot context assembly

## Prior Work

PR #332 added rich pill with section expansion, source lists, and recipe-driven budgets. This builds on that to fix scroll behavior and add full markdown view.
