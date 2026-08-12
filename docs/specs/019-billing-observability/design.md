# Billing Observability Design

```text
Runtime JSONL / provider quota / agentmetrics
                  ↓
        normalized UsageRecord
          ├── tokens                 observed universal usage
          ├── costs.apiEquivalent    current public API rate
          ├── costs.metered          provider-reported/API billed amount
          ├── costs.subscription     quota fraction × configured price
          └── quotaImpact            before/after provider evidence
                  ↓
          FleetControlService
                  ↓
     turn evidence → session aggregate → WorkItem/PR aggregate
```

`usage` remains the raw turn/session evidence list. `cost` remains as a
compatibility projection. New consumers should use
`totals.costs.apiEquivalent`, `totals.costs.metered`, and
`totals.costs.subscription`.

Provider polling records marked `session-cumulative` are deduplicated by
Session and only the latest snapshot contributes to totals. Agentmetrics
reports marked `turn` contribute once per `turnId`.

Subscription allocation is deliberately explicit:

```text
subscriptionCost = periodPrice × fractionOfBillingPeriod
fractionOfBillingPeriod = consumedPercentage / 100
```

The fraction is accepted only from a provider-reported quota delta or a
user-entered bounded allocation. A quota reset or ambiguous concurrent account
usage produces an unavailable/low-confidence allocation instead of a number.

Pricing resolution order:

1. invoice/user override for the matching provider + plan + effective period;
2. official local catalog snapshot;
3. unavailable.

The catalog is versioned and includes source URL/retrieval date. It is not a
live browser scraper. Account plan type/quota may be collected through the
provider's documented read-only endpoint, but account authentication remains
outside Fleet and no secret is persisted.
