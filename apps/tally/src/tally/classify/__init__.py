"""Classify: a descriptor string in, a category and a confidence out.

The privacy line lives here. Only `Request.descriptor` strings leave the
process, never an amount, a date, a balance or an account number, and a
`Cascade` sends each unique string at most once, caching the answer as a
Rule. `tally.classify.base` has the interface; `rules`, `embed` (v1.x) and
`providers/*` implement it; `cascade` chains them.
"""

from tally.classify.base import Cascade, Classifier, Request, Result

__all__ = ["Cascade", "Classifier", "Request", "Result"]
