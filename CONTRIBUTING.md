# Contributing

The project is in extraction alpha. Small changes that establish a reusable
contract while preserving the Zagreb compatibility fixture are preferred over
large rewrites.

Before opening a change:

1. Read the ownership boundaries in `AGENTS.md` and `docs/architecture.md`.
2. Run `npm test` and `npm run build`.
3. Add a headless test for domain, manifest or provider behavior.
4. Describe which city capabilities are required and how absence is handled.
5. Record any new code, data or media licence and attribution.

Code contributions are accepted under the project's MIT License. Data and
media must include their own compatible licence and provenance information.

Do not add city checks to core code. Put local configuration and datasets in a
city pack and expose them through a provider contract.
