# P-8b Anthropic source boundary — 2026-10-18

## Scope and evidence

The Anthropic slice proceeds independently of the still-open OpenAI response research. The existing adapter contract permits required-existing authorization at sources/contract.mjs:56. The measured Claude 2.1.302 mod supplies an opaque authorization handle only to native HTTP; the source adapter receives a caller-owned fetch function and never a credential. The sanitized fixture keeps three public identifiers and capability/limit fields from that read-only probe. No default network transport, automatic activation, model execution or runtime availability claim is added.

The [official Models API](https://platform.claude.com/docs/en/api/models/list) describes a paginated list with nullable capability facts. This adapter records only explicit reasoning support, supported effort values and input context limits. It ignores model-name spelling and response order, ordinary tool support is not inferred from code_execution, and API availability is not native runtime entitlement. API-reported effort support can conflict with a runtime or another source; this adapter does not resolve that conflict or assert native binding. The shared catalog and resolver retain that responsibility.

## First failing checks

The first test run fails because the adapter does not exist. After implementation, nineteen checks pass and two fail. One timeout assertion names network_timeout, but the existing bounded-operation contract uses timeout; the assertion is corrected to the actual shared contract.

For the error-text failure, candidate one is response-body echoing. Against it: the test transport fails before returning any response. Candidate two is the bounded-operation diagnostic retaining the thrown message. Confirmed by the result, which has network_unavailable and the injected message, and by sources/contract.mjs error classification. The adapter must sanitize that message locally while preserving the shared status/code and retryability. This prevents native transport details from entering capability evidence or logs without changing unrelated adapters' contract.

The fixture is an explicit field subset. It contains no authorization handle, credential, account metadata, runtime availability assertion or user preference. Public API facts need no copied source-document notice; no provider prose or SDK code is redistributed.
