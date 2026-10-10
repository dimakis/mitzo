# Document editing with Vim

Open an editable document in **Files** and choose **Edit**, or select a document
in **Knowledge** to edit its working copy. Desktop source editing
uses CodeMirror with line numbers and ordinary keyboard selection by default.
Choose **Vim** to enable Vim editing; **Standard** returns to ordinary editing
without discarding the current draft. Touch devices default to the native text editor
and standard selection behavior. Desktop and touch Vim preferences are remembered
separately; enabling Vim on desktop does not change the touch default.

The Vim badge shows **NORMAL**, **INSERT**, or **VISUAL**. Common motions and
operators work, including `h/j/k/l`, word motions, `gg/G`, `dd`, and text objects
such as `ciw`. Press `i` to insert, `v` to select visually, and Escape to return
to Normal mode. Use `u` to undo and Ctrl-R to redo. **Relative line numbers** shows
the distance from the current line while keeping its absolute number.

Use **Save**, Cmd/Ctrl-S, or Vim `:w` followed by Enter to save through the same
document save flow. While a save is pending, the source is read-only. Save errors
preserve the draft; concurrent changes still require reviewing the latest saved
version before resolving the conflict. In Knowledge, Save and `:w` preserve the
working copy as a draft through the existing review flow; accepting and publishing
knowledge remain separate actions.

**Source**, **Preview**, and **Split** share the same unsaved content. **Fullscreen**
expands the editing workspace and keeps save controls available; **Exit fullscreen**
returns to the file layout with the draft intact. Markdown formatting controls
remain available in both Standard and Vim source and split views, including Vim
Normal, Insert and Visual modes. HTML previews retain their sandbox.

Browser verification uses compiled frontend assets, intercepted file responses,
and blocked WebSockets in the offline Playwright suite. It does not start a
backend or make provider requests.
