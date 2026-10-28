# Active skill workflow

This repository keeps only the skills needed for the feature-delivery loop in
the diagram:

```text
grill-me → to-spec → to-tickets → implement → code-review → pr → retro
                                  └→ implement-spec (parallel whole-spec path)
```

## Active skills

- `productivity/grill-me`: clarify the idea through a structured interview.
- `engineering/to-spec`: publish the agreed conversation as a spec.
- `engineering/to-tickets`: split the spec into dependency-aware tickets.
- `engineering/implement`: implement tickets one at a time.
- `engineering/implement-spec`: implement a whole spec in parallel on one integration branch.
- `engineering/code-review`: review standards and spec compliance.
- `engineering/pr`: prepare a concise pull-request body.
- `engineering/retro`: identify improvements to the agent environment.

## Required supporting skills

- `productivity/grilling`: interview primitive used by `grill-me`.
- `engineering/tdd`: test-first loop used by implementers.
- `productivity/writing-for-agents`: writing guidance used by `retro`.

No other project skills are installed in this repository.
