# Machine translation runs

What `translate-one.mjs` did to the four harness pages the author's supplied
set does not cover. Every run ended the same way — `verification clean 2x in a
row` — which is the pipeline's own evidence that no Japanese survived it:
after drawing, it re-reads the **drawn** image quadrant by quadrant, looks for
anything it can still recognise as unreadable, and only stops when two
consecutive passes find nothing.

`declined` labels are not failures. They are boxes the model offered that
`draw.py` refused to paint, for the reasons named — `no-text` (the box holds no
text at all), `duplicate` (already covered, erased only), `overlap` (would sit
on top of something already drawn), `already-english` (printed Latin, protected
rather than replaced).

| page | labels | drawn | declined | verification | cost |
| --- | --- | --- | --- | --- | --- |
| `wiring-1993-p0019.jpg` | 107 | 86 | 13 no-text, 5 duplicate | clean 2× | ~$0.0136 |
| `wiring-1993-p0020.jpg` | 2 | 1 | 1 no-text | clean 2× | ~$0.0100 |
| `wiring-1993-p0022.jpg` | 332 | 283 | 30 no-text, 9 duplicate, 6 overlap | clean 2× | ~$0.0252 |
| `wiring-1993-p0024.jpg` | 138 | 113 | 16 no-text, 6 duplicate, 2 overlap, 2 already-english | clean 2× | ~$0.0235 |

Wire pixels restored by `draw.py` — ink it would otherwise have eaten, put
back — 17,890 (p0019), 0 (p0020), 74,067 (p0022), 284 (p0024).

`p0020` is the odd number because it barely needs translating: it is the
harness routing overview, a pictorial page whose only Japanese is the
"Harness symbols" legend. Its full round-by-round output is
[`wiring-1993-p0020.log`](wiring-1993-p0020.log); the other three were run
before this directory existed and their final lines are transcribed above.

All four were then checked by eye at full resolution — `p0019` against the
original in the same crop, so the printed Latin (`JC-01`, `Black`,
`Black/orange`), the wires and the connector symbols could be compared
directly with what English replaced.

Total: about **$0.07** for four pages.
