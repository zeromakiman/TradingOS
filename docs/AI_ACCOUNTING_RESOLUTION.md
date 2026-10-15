# AI accounting incident resolution (0014)

This is an operator procedure, not a customer control or an HTTP endpoint. Nothing here clears the two existing staging incidents automatically. No production changes are authorized by this work.

## Trust boundary

Migration 0014 creates the NOLOGIN role `ai_accounting_operator` without granting membership to anyone. A DBA must separately authorize a **named database login** to use it. Never grant it to `anon`, `authenticated`, `service_role`, `authenticator`, an application connection pool, or an ordinary account user. Use a secure direct database connection; no browser/API keys or operator credentials belong in application environment variables.

The only mutation entry is `private.resolve_ai_uncertainty`, outside the exposed public API schema. It requires both SQL execute privileges and membership of the authenticated database `session_user` in the operator role. The resolver is captured from that login, not from supplied text or a JWT. Application service credentials cannot execute it. The role can read resolution audit rows but cannot insert/update/delete them directly or modify original usage. Database superusers remain inherently privileged; routine operations should use individual operator logins, not a shared administrator identity.

DBA provisioning, only after separate access approval:

```sql
GRANT ai_accounting_operator TO your_named_operator_login;
```

The migration does not create login credentials. Revoke membership after temporary incident access if appropriate.

## Investigate first

1. Identify the exact reservation, account, request timestamp, provider/model, stored pricing snapshot, dispatch and original UNCERTAIN usage record.
2. Match authoritative provider usage/billing evidence to that exact request. HTTP 429 by itself is not proof of zero usage. Do not infer zero from missing application metadata.
3. Record a meaningful reason and a durable investigation/evidence reference. Do not store API keys, tokens, passwords or unrelated personal data in audit notes.
4. Choose an explicit decision. Any ambiguity means KEEP_UNCERTAIN.

| Decision | Effective budget accounting |
| --- | --- |
| KEEP_UNCERTAIN | Retain the original amount and account-wide block. Multiple investigations may append. |
| NO_PROVIDER_USAGE_CONFIRMED | Terminal resolution: zero effective charge and release the original uncertain amount. Requires confirmed no-usage evidence. |
| USAGE_CONFIRMED | Terminal resolution: use the explicitly verified cost, release only the difference, preserve usage/cost evidence. |

There is at most one terminal resolution per reservation. It cannot be overwritten or reopened. A repeat of the same resolution UUID and identical content by the same login is idempotent; conflicting reuse is rejected. Check evidence carefully before a terminal decision.

## Execute an explicit decision

Use parameterized SQL from the secure operator session; this example contains placeholders, not real incident identifiers:

```sql
SELECT private.resolve_ai_uncertainty(
  p_id := :new_resolution_uuid,
  p_reservation_id := :investigated_reservation_uuid,
  p_decision := :explicit_decision,
  p_reason := :investigation_reason,
  p_evidence_ref := :durable_evidence_reference,
  p_details := :verified_details_json
);
```

KEEP_UNCERTAIN and NO_PROVIDER_USAGE_CONFIRMED require `{}` details. For USAGE_CONFIRMED choose one explicit cost basis:

- `PROVIDER_BILLED_EUR`: `chargedMicros` is the confirmed EUR amount multiplied by 1,000,000 (round upward if necessary), with `providerReference` identifying its evidence.
- `PROVIDER_BILLED_USD`: include the confirmed `billedUsd` decimal string, `providerReference` and `chargedMicros`. SQL verifies the micro-EUR amount against that reservation's preserved `usdCostToEurBudgetMultiplier`, rounding upward. This is converted budget accounting, not a claim of EUR invoicing. Missing historical conversion fails closed.
- `PROVIDER_USAGE_ESTIMATE`: include `chargedMicros`, `providerReference`, `responseModel` and the authoritative provider `usage` object containing input/output token counts plus available cache/reasoning details. Compute the amount offline with the existing `priceUsage(usage, reservation.pricing)` and the recorded provider adapter's accounting rules. Validate the returned model against that preserved profile. Use the **reservation's historical pricing/conversion**, not today's profile. For another provider use its reviewed adapter. This is an operator-attested application estimate, not an invoice.

The SQL boundary validates required evidence fields and integer amounts but does not independently verify the provider evidence or reimplement pricing. Only the separately trusted operator may attest the cost. For an unreviewed model or unpriceable usage, keep the record uncertain until reliable billed cost/pricing evidence exists. USD billed cost uses the explicit PROVIDER_BILLED_USD basis above.

A confirmed cost above the original amount is recorded in `additional_micros`, never clamped or hidden. It can put the account above its cap; further requests remain denied. The resolution cannot raise a cap or opt the account in.

## Audit and verification

`public.ai_uncertainty_resolutions` preserves decision, reason, evidence reference, database resolver, server timestamp, original/reconciled/released/additional micro-EUR and confirmation details. RLS permits owners to read only their own resolutions; anonymous access is denied. Account users and service credentials have no resolution-write privilege. Original reservations, usage, failed reviews and model output are not updated or deleted. Their historical UNCERTAIN labels remain a truthful incident snapshot; the resolution ledger supplies the subsequent decision.

Resolution, reserve, dispatch, settle and preferences use the same account row lock. The effective budget overlays only terminal decisions and charges the **original reservation month**. A historical release never grants extra credit in a new month. Any other unresolved incident, even from a prior month, continues to block the account.

After resolving, read the audit row, original incident and authenticated `get_account_ai_budget` result. Check ownership, exact deltas, original history preservation and remaining uncertainty. This procedure does not request AI or retry an old review. An explicitly authorized future review gets a new immutable history entry and new reservation.

## Rollout boundary

Apply 0014 to isolated staging only after reviewing this migration. Provision operator access separately, investigate each existing staging incident, and make an explicitly authorized decision. This implementation has applied nothing to hosted staging or production and has resolved neither existing staging incident.
