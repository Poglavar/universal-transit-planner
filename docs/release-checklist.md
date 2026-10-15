# Public alpha checklist

- [x] Select an OSI-approved code licence and add `LICENSE` (MIT).
- [x] Complete code, data, model and media provenance review. HŽPP GTFS reuse
      permission is confirmed; the Zagreb logo is project-authored MIT media;
      DGU separately approved the existing deployment, but its terrain data is
      not redistributed or offered for reuse. Project-authored code remains MIT.
- [x] Replace the sibling Station3D dependency with the exact public release tag
      declared in `package.json`; Git installation builds and vendors its own `dist/`.
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

## Publishing an update

1. Bump the version in `package.json` and both root version fields in
   `package-lock.json`, preserving the locked dependencies. Run the unit suite
   and both portable and Zagreb builds.
2. Push the release commit and its matching `v<version>` tag. The
   `Release static builds` workflow publishes the example and Zagreb archives
   with `SHA256SUMS`; verify the completed workflow and downloaded artifacts.
3. Update `UTP_VERSION` and `UTP_SHA256` together in the consuming
   `Poglavar/zagreb-isochrone` repository's `deploy-to-server.sh`, using the
   published Zagreb archive's checksum. Verify its download and install selection
   in an isolated directory before pushing the consumer pin.

A planner `main` push or a direct live symlink update does not update that consumer
pin. Its next normal deployment selects the pinned tagged release, so publishing
the release and updating the consumer pin complete the release-maintenance work.
