# Pi extension host adapter

This package owns the nine ticket tool schemas, validation, confirmation gates,
redaction, and delegation to an injected orchestrator. `registerPiTools` is the
narrow adapter to Pi's host surface (`ExtensionAPI.registerTool`).

The repository does not include the Pi SDK package, so `@agent-farm/pi-extension`
does not import `@earendil-works/pi-coding-agent` (the host's current Pi SDK).
A Pi host must provide its `ExtensionAPI.registerTool` implementation and,
when needed, convert the exported JSON schemas to the SDK's TypeBox `TSchema`.
The fake host contract in `src/extension.test.ts` covers this boundary.

Create the DEV-31 runtime in the host, adapt its orchestrator to
`PiOrchestrator`, then call `registerRuntimePiTools(pi, { orchestrator })`.
Runtime startup and shutdown remain host-owned; registration neither starts nor
closes the runtime.
