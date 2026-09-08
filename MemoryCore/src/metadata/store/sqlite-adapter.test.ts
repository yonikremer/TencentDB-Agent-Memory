/**
 * SQLite IMetadataStore contract run — backend-agnostic suite on :memory:.
 * (Previously the shared suite had no runner; org-sync groupy tables join it.)
 */
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

runMetadataStoreContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => { await store.close(); },
);
