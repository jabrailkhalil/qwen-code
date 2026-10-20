# Primary device credential revocation: scope handoff

[English](mobile-device-revocation-handoff.md) | [简体中文](mobile-device-revocation-handoff.zh-CN.md)

## Status and ownership

Proposal for maintainer scope confirmation, not an implemented API or a security acceptance claim. Source reviewed at `c8971faac9e2204f31bd06ffba94f8c92725f267` on October 20, 2026.

The Android shell direction was accepted in [#11704](https://github.com/QwenLM/qwen-code/issues/11704), but [the maintainer decision](https://github.com/QwenLM/qwen-code/issues/11704#issuecomment-5645279859) retained primary-listener revocable credentials as daemon-team work. [The later status](https://github.com/QwenLM/qwen-code/issues/11704#issuecomment-5807811203) still lists revocation, background SSE and notifications as open. This note does not transfer that ownership or override the contribution gate.

The smallest proposed contribution is a separately agreed acceptance fixture or implementation slice after the daemon owner confirms the contract. It must not expand the open downloads PR #12130 or the Feishu coverage PR #13278. The frozen Phase 2 disposition record #13111 is not a delivery backlog for this work.

## Current behavior

Maintainer-authored [#12322](https://github.com/QwenLM/qwen-code/pull/12322) already introduced independent Web Shell device credentials on the primary listener. Reuse that path; do not invent a second Android token system. The [existing design](web-shell-dynamic-pairing.md) explicitly defers individual revocation and device-management UI.

- The primary listener accepts the runtime bearer and hashed Web Shell device bearers. Local Control accepts its separate pairing credentials, not either primary credential kind.
- The QR invitation lasts 60 seconds and is single-use. Exchange creates a random 32-byte device bearer. There are at most 64 live invitations and 128 device bearers; reaching capacity refuses another pairing rather than evicting existing devices.
- Device credentials belong to the app's in-memory store. Supported trust/environment reloads retain that app; daemon restart, including `execve` replacement, clears the device credentials. The existing design calls this process-lifetime access. Invitation expiry does not expire an exchanged device bearer. This lifecycle was inspected in source, not exercised as a real restart by the store probe.
- The device store is a set of digests without stable device IDs, a list operation or an individual revoke operation. Successful HTTP authentication retains only a boolean, not the credential identity.
- A paired primary bearer can currently issue another invitation. Desktop-relay credentials are also derived separately without issuer/device lineage. Deleting only one stored digest would not define what happens to descendants or unspent derived credentials.
- Android stores the supplied credential with the existing encrypted profile vault. Deleting a local profile does not revoke daemon access; the current UI and README correctly say so.

This is an explicitly deferred feature, not a claim that the current implementation promises individual revocation or that a live tenant has suffered a security incident.

## Consumer and lifetime boundaries

| Boundary                               | Existing source                                                                              | Obligation before claiming revocation                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process-global primary REST            | `packages/cli/src/serve/auth.ts`, `server.ts`                                                | Preserve runtime/device/Local Control isolation; use authenticated credential identity, never a caller-supplied client ID.                                                              |
| Remote same-origin validation          | `server/self-origin.ts`                                                                      | Preserve Host, Origin and pre-auth exceptions; do not treat a revoked credential as an allowed same-origin credential.                                                                  |
| New WebSocket admissions               | `acp-http/index.ts`                                                                          | Keep the shared gate for ACP, workspace ACP, CDP, voice and extra live routes; reject revoked credentials regardless of header/subprotocol transport.                                   |
| Existing SSE and WebSocket connections | `routes/sse-events.ts`, `routes/session-agents.ts`, `routes/session.ts`, `acp-http/index.ts` | Decide and test targeted closure. Their current admission checks do not retain a device principal for later revocation. Closing the whole primary listener is not selective revocation. |
| Root-only daemon update                | `routes/daemon-update.ts`                                                                    | Keep the intentional runtime-credential-only authority; do not broaden it to paired browsers.                                                                                           |
| Cold start, restart and reload         | `run-qwen-serve.ts`                                                                          | Decide persistence and reload behavior with the daemon owner; current process-lifetime tokens must not silently become durable or gain bootstrap authority.                             |
| Local Control                          | `local-control/service.ts`                                                                   | Keep separate LAN revocation/listener teardown unchanged; it is not a per-device primary revocation implementation.                                                                     |

The new management surface, if approved, is process-global rather than workspace-scoped. Revocation of a credential must not accidentally stop unrelated devices or fall back to a primary workspace runtime.

## Decisions required from the daemon owner

1. Which authenticated principal can list and revoke devices: root operator only, self-revocation, or the current full-operator bearer model? What does the open loopback deployment mean for this authority?
2. What is a stable non-secret device identifier, and is the registry process-lifetime or persistent? Token digests, bearer material and untrusted client labels must not become public identifiers or logs.
3. Does revocation immediately close existing access, or only reject new admissions? A lost-device claim must explicitly cover the existing SSE/WS paths, not just a new HTTP request.
4. What happens to outstanding invitations, already paired descendants and unused desktop-relay credentials issued by that device?
5. Does revocation stop underlying agent work, or only the client's observation/control? Specify prompt, permission and in-flight response behavior without creating duplicate work on reconnect.
6. Which route names, capability/version signal, response/error contract, audit fields and security review fit tracker [#4514 T2.2/T3.6](https://github.com/QwenLM/qwen-code/issues/4514)? Do not create a separate one-off token store.

No answer to these questions is assumed by this handoff. In particular, adding a public delete route while every bearer is recorded only as an authenticated boolean is not the proposed first patch.

## Acceptance matrix after scope confirmation

Use synthetic credentials and a local model-free daemon fixture. Reuse existing pairing and transport fixtures rather than copying their implementations into an alternative server.

- Pair A and B independently; both can use the documented REST+SSE client surface before revocation. Runtime and Local Control scope controls retain their current results.
- Revoke A through the approved authority. A's new REST and WebSocket admissions fail; B and the runtime operator remain usable. Forging a client-ID header or using A's bearer on another listener does not restore access.
- Apply the declared existing-stream rule to A's ordinary/session-agent/generation SSE and WS surfaces. B's live stream remains connected. Each subscription/socket is cleaned exactly once, including disconnect/revoke races and backpressure.
- Apply the declared descendant/invitation/relay rule. An unspent derived credential must not accidentally bypass that rule.
- Preserve invitation expiry, one-use/origin checks, rate limiting, capacity refusal, tokenless-loopback behavior and restart/reload compatibility. Define whether revocation releases a capacity slot.
- Return only approved non-secret metadata. No bearer, digest, invitation or encrypted vault value is printed in routes, logs, assertion failures, screenshots or reports.
- Keep Android profile deletion's existing wording until server revocation is actually implemented and integrated. Do not label the development shell official-client-ready from a design, store probe or compiled instrumentation APK.

## Validation status and limits

This change contains documentation only. Static source review is complete; an independent store-level baseline probe is recorded separately under `.qwen/investigations/device-revocation/`. A store-level probe does not execute the real HTTP, SSE, WebSocket or Android lifecycle.

The global `qwen` executable is not available on this environment's PATH. The required global-CLI dry-run, full daemon acceptance matrix, Android process/background tests, screenshots, and before/after verification remain unexecuted. No production implementation, credential mutation or live provider call is included. The E2E plan is `.qwen/e2e-tests/mobile-device-revocation.md`; results must remain separated by test layer.
