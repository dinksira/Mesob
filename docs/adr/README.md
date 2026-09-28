# Architecture decision records

Five records for the decisions that are expensive to reverse. Each one was a genuine fork, and
each is written so that someone who disagrees can see exactly what would have to be true for the
alternative to win.

## Why only these five

Most of the twenty decisions in [01 §5](../01-system-design.md#5-key-design-decisions) are not
worth a record. "Use Postgres" or "put the client metrics in Sentry" are not reversals; changing
them costs an afternoon. The five below share a property: once code exists against them, the cost
of changing course is not an afternoon, it is a rewrite of the thing that is supposed to be the
case study.

The test applied was: *if this decision were wrong, how much of the system would have to be
touched?* Three of the five fail a full rewrite. Two of the five fail a migration.

## The records

| # | Record | Covers | Status |
|---|---|---|---|
| [0001](0001-crdt-merge-model-and-granularity.md) | CRDT merge model and document granularity | D1, D2 | Accepted |
| [0002](0002-shape-representation-and-z-order.md) | Shape representation and z-order | D3, D5 | Accepted |
| [0003](0003-restore-is-a-forward-update.md) | Restore is a forward update, never a rollback | D12 | Accepted |
| [0004](0004-authorization-before-apply.md) | Authorization happens before apply, on every message | D10, D11 | Accepted |
| [0005](0005-hosting-option-a-first.md) | Option A ships; Option B is written up, not dismissed | D17 | Accepted |

## Format

Each record uses the same five sections, in this order:

- **Status** — Accepted, with the date.
- **Context** — the situation forcing the decision, and the constraints that were not negotiable.
- **Decision** — what was chosen, stated as a rule the code can check.
- **Consequences** — what this makes easy, and what it makes expensive. The bad half matters more
  than the good half.
- **Alternatives considered** — each with the specific reason it lost, and what evidence would
  reverse it.

## Conventions

- A record is immutable once accepted. Changing a decision appends a new record and marks the old
  one `Superseded by ADR-NNNN`. Rewriting history here would defeat the point of keeping records
  that this project does not otherwise have.
- Records reference the numbered decisions in [01 §5](../01-system-design.md#5-key-design-decisions)
  by their `D` number, so a decision table change is traceable to a record.
- A deviation from an accepted record in code is a defect, not a preference. It gets an ADR.
