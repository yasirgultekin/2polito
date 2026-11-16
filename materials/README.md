# Course material

This folder is intentionally empty in the repository: the professors' slides and notes are not ours to redistribute.

Put the material for each unlocked course in a subfolder named after its id in `data/courses.json`:

```
materials/
└── computer-networks/
    ├── 01-Network_fundamentals.pdf
    ├── 02-protocol_architectures.pdf
    └── notes/summary.md
```

- Supported: `.pdf`, `.md`, `.txt` (convert `.pptx` slides to PDF first). Subfolders are fine.
- You can also drag and drop files into the portal's sidebar.
- On start (or with **Re-index**), files are split per page, embedded once and cached in `.cache/`. Unchanged files are never re-embedded.

Everything in this folder except this README is ignored by git.
