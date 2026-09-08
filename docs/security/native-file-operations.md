# Native file operations

Read, Write and Edit authorize one canonical path through the existing native-tool permission policy. Execution never resolves that path again through ordinary pathname-based reads or writes.

The embedded helper in `server/native-file-operation.ts` opens the canonical path from `/`, one component at a time, using Python's descriptor-relative `os.open(..., dir_fd=...)` with `O_NOFOLLOW`. Every intermediate component must be a directory. Symlink substitutions therefore fail at lookup, and replacing a directory after it has been opened cannot redirect the next lookup. The final file must be regular and have exactly one hard link. The executor captures existence and device/inode identity for the file and its parent directory before approval. The pinned parent descriptor must match its approved identity before any final-file open or creation. Existing files are opened without truncation and their descriptor identity is compared with the approved identity before any content access. A path approved as absent must still be created exclusively. Edit reads, replaces and truncates through the same descriptor.

Write creates missing files exclusively with mode `0600` (subject to umask). Existing-file permissions are retained. Dangling symlinks, special files and hard-link aliases are deliberately unavailable to these tools. Pre-existing valid symlink aliases still work when canonicalized and approved before execution; later substitutions cannot redirect the approved canonical target.

## Runtime requirement

macOS or Linux with Python 3 and support for `os.open`'s `dir_fd`, `O_DIRECTORY` and `O_NOFOLLOW` is required. Python is launched with `-I` and a fixed system/Homebrew search path, without inheriting provider credentials or Python configuration. The request travels over stdin, never through shell interpolation or command-line arguments. The helper is embedded in compiled JavaScript, so deployment requires no separately copied script. Missing runtime support, process failures, cancellation and timeout return a tool error; there is no pathname-I/O fallback. The default operation timeout is 30 seconds.

Python's API maps directory-relative opens to the platform's `openat` operation: [Python OS documentation](https://docs.python.org/3/library/os.html#os.open). Node's `O_NOFOLLOW` only protects the opened path's last component, so a direct Node file open alone cannot protect intermediate components: [Node filesystem constants](https://nodejs.org/api/fs.html#file-open-constants).

## Proof and limits

`server/__tests__/native-file-race.test.ts` swaps both ancestors and final filenames at the execution boundary, after authorization, and asserts that private content is neither returned nor modified. Its post-open tests inject a filename replacement inside the real helper and verify that reads/writes stay on the already-open original file. Other tests retain approval-wait, dangling-link, credential-root, size-limit and permission behavior.

This closes symlink redirection between pathname authorization and file access, including Edit's former second open. It does not make writes transactional or synchronize simultaneous content edits. Cancellation or I/O failure may leave a partial write. An already-open object remains the authorized object if another process renames it. This is not a host sandbox against a process that can arbitrarily move credential files, mutate another process, or change mounts. Broader file API authorization and OpenShell enforcement remain separate audit workstreams.
