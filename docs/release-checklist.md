# Public alpha checklist

- [x] Select an OSI-approved code licence and add `LICENSE` (MIT).
- [x] Complete code, data, model and media provenance review. HŽPP GTFS reuse
      permission is confirmed; the Zagreb logo is project-authored MIT media;
      DGU separately approved the existing deployment, but its terrain data is
      not redistributed or offered for reuse. Project-authored code remains MIT.
- [x] Replace the sibling Station3D dependency with exact public release tag
      `v0.1.0-alpha.1`; Git installation builds and vendors its own `dist/`.
- [x] Provide a compatible API or a documented read-only demo provider.
- [x] Start the portable demo from a fresh clone with the documented
      `npm ci && npm run dev` path.
- [x] Keep campaign code and assets out of the planner distribution (enforced
      by `test/extraction-boundary.test.mjs`).
- [x] Pass the complete unit suite and both portable and Zagreb builds from a clean checkout.
- [x] Render all manifest provider attribution in the application.
- [x] Add security policy, code of conduct and issue templates.
- [x] Publish the repository from a single sanitized root commit; the private
      incubation history remains in a separate private archive.
