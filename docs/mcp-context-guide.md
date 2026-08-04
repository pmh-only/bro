# MCP Context Guide

## Audit findings

The MCP server has no MCP resources; its context-heavy surface was concentrated in tools that returned complete `Job` objects. A full job can include embedded base64 attachments, long task/result/error/operational text, filesystem and session details, and internal coordinator fields. The `status` active-job list and `projects` list were also unbounded.

The largest practical risks were:

- `status` returning every field for every active job.
- Mutation tools returning a complete job when callers usually need only its ID and state.
- Reading one result or progress value requiring the complete job, including attachment data.
- `projects` returning the entire registry without pagination or field selection.

## Compact calls

Existing calls without response controls retain their original response shapes for compatibility.

Use `detail: "minimal"` on `run`, `global`, `instruction`, `clone`, `status`, `cancel`, or `history` when only identity and state are needed. Use `detail: "summary"` for job monitoring; summaries include state, scope, project alias, timestamps, progress, and token consumption when available, but omit attachments and long result fields.

```json
{ "name": "status", "arguments": { "jobId": "a1b2c3d4", "detail": "summary" } }
```

For exact job metadata, `status.fields` overrides `detail` and returns only requested fields:

```json
{ "name": "status", "arguments": { "jobId": "a1b2c3d4", "fields": ["id", "state", "progress"] } }
```

Controlled active-job and project lists return `{ items, total, offset, limit, nextOffset? }`. `limit` is capped at 100 and defaults to 20 when another list control is supplied.

```json
{ "name": "status", "arguments": { "detail": "minimal", "offset": 0, "limit": 20 } }
{ "name": "projects", "arguments": { "fields": ["alias"], "offset": 0, "limit": 20 } }
```

Use `job_output` to read only `task`, `progress`, `result`, `error`, or `operationalDetails`. It returns at most 4,000 characters by default and at most 20,000 per call. Continue from `nextOffset` when present.

```json
{ "name": "job_output", "arguments": { "jobId": "a1b2c3d4", "field": "result", "offset": 0, "maxChars": 4000 } }
```

## Migration notes

- No migration is required for existing clients: omitted controls preserve full objects and unpaginated arrays.
- New clients should use `detail: "minimal"` for queue/cancel acknowledgements and `detail: "summary"` for polling.
- Prefer `status.fields` over `detail: "full"` when only a few metadata values are needed.
- Prefer `job_output` over requesting `result`, `error`, or operational text through a full status response.
- Supplying pagination, fields, or detail while listing active jobs changes that response from a legacy array to a page envelope.
- Supplying fields or pagination to `projects` changes that response from a legacy array to a page envelope.

## Follow-up recommendations

- Measure MCP response byte counts in production to choose whether compact responses can become the default in a future major version.
- Consider moving embedded attachment data to bounded, targeted reads if agents need attachment inspection over MCP. Current compact views omit it, while explicit `fields: ["attachments"]` and legacy full responses remain intentionally unbounded.
