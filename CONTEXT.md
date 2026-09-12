# Agent Memory Wiki Ingest

Wiki accepts uploaded source files, renders one markdown per file, and ties each markdown back to its source. Markdown is the only indexed form; OneNote is out of scope.

## Language

**SourceFile**:
Original uploaded bytes, stored once and never mutated.
_Avoid_: raw file, upload, binary_

**RenderedMd**:
Markdown derived from one SourceFile; the only form the wiki indexes.
_Avoid_: md file, converted file, raw_md_

**Conversion**:
One SourceFile rendered to one RenderedMd with a recorded outcome.
_Avoid_: convert job, pipeline run_

**SourceLink**:
Recorded tie from a RenderedMd back to its SourceFile.
_Avoid_: link, reference, attachment_
