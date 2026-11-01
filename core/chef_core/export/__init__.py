"""Exporters for the document model (v0.10: N4 formats, N5 Word modes, N6 refresh, N7 batch).

``ir.build_ir`` turns a :class:`chef_core.layout.model.DocModel` into one intermediate list of items
(headings, paragraphs, lists, tables, images, rules, page marks) that every renderer reads. Each
format lives in its own module and writes its file atomically (``pdf/io.atomic_write``).

Dispatch and the output names of the operations are in :mod:`chef_core.export.run` and
:mod:`chef_core.export.names`.
"""

from __future__ import annotations
