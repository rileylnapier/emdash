# Taixu desktop fork

This branch makes a local Taixu checkout the desktop home screen. The four Heads are available in the title bar; the original Emdash workbench is available under **Inspect work**. The workbench remains mounted while hidden after its first visit, preserving active tasks.

The generic host feature lives in `apps/emdash-desktop/src/core/features/taixu`. It launches the checkout's `apps/taixu/server/desktop.mjs` as an owned Electron utility process. The folder is selected on first launch (or supplied through `TAIXU_ROOT`); a local package can include a `taixu-root.json` resource containing `{ "root": "/path/to/checkout" }`. Saved user selection takes precedence over that resource.

The host exposes only selected task/project/conversation status metadata to the world. The iframe can request a native task dialog with a brief or navigate to an existing task. Starting work still requires the native Create action. Agent provider execution, approvals, worktrees, review and terminal handling remain Emdash's existing implementations.

This branch uses a separate Taixu app identity and data directory. Upstream Emdash updates and automatic publication are disabled. Local Taixu data, the project registry, notebooks, briefs and credentials are not part of this public repository. Agent CLIs and their existing authentication are still required.

Use the normal upstream pnpm build and checks. For the complete local app build and packaging workflow, follow the desktop documentation in your LoveLife checkout. No release workflow is needed.
