# metadata-instances.json Field Description (New Panel stateless)

| Field | Required | Description |
|------|------|------|
| `id` | is | = `instance_id` = kernel `x-tdai-service-id`; commonly `default` locally, `mem-{slug}` in production |
| `name` | is | Display name on the login page; **only** exposed via `GET /api/v1/meta/instances` |
| `gateway_endpoint` | is | Root URL of the Memory Gateway; `http://127.0.0.1:8420` locally. **Forwarding address from Panel backend to Kernel; do not use it to refer to a proxy** |
| `proxy_endpoint` | no | Client access baseUrl (CodeBuddy / ClaudeCode CLI, etc.). **Only** used for concatenating and displaying in the Panel UI "Client Access Address" card. Falls back to `gateway_endpoint` when missing, equivalent to the old behavior. When deployed in production with a proxy in front of the gateway, the two values are unified and can be omitted; when deployed locally with separate core and proxy, fill in the proxy's external address here (e.g., `http://127.0.0.1:8096`) |
| `api_key` | is | Gateway Bearer; **only** used by the server for forwarding, **not** present in the instances API |

## Local file (contains keys, not stored in database)

```bash
cp config/metadata-instances.example.json config/metadata-instances.json
# Fill in gateway_endpoint / api_key according to this machine's Gateway
```

`config/metadata-instances.json` has been added to `.gitignore`; the repository only retains `metadata-instances.example.json`.

> **Update Notice**: Before the first pull to "File Outbound" commit, please back up the local `metadata-instances.json`; if the file is deleted after pulling, restore it from the backup, or copy it again from the example and fill in the key as instructed above.
