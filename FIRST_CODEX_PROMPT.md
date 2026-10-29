# First Codex prompt for NOVA Ink

Please read `AGENTS.md`, `CODEX_HANDOFF.md`, `README.md`, and the actual implementation and tests.

This is the working NOVA Ink v0.2.1 source, already connected to a private ChatGPT plugin and tested on iPad. **Do not recreate the project from scratch.**

Start with a READ-ONLY audit. Verify the project root, Git status, Node/npm versions, current dependencies, `npm test`, `npm run build:host-test`, and the save / lease / widget metadata architecture. Identify any inconsistencies between the handoff and code.

Then propose a minimal plan to:
1. Establish a clean local Git baseline without committing secrets or personal notebook data.
2. Finish reliability acceptance for concurrent editor handoff and backup recovery.
3. Implement the top-mounted tldraw toolbar without changing Apple Pencil gesture behavior.

Report findings and the smallest first code change. Don't modify application code, initialize or publish Git, change the tunnel, or deploy until I approve the plan.
