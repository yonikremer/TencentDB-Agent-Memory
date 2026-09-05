/**
 * api/assets.ts — Asset Management (meta/asset/*).
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Asset, AssetType, AssetStatus } from './types';

function newExternalAssetId(assetType: AssetType): string {
  const prefix = { skill: 'skl', llm_wiki: 'wiki', code_graph: 'cg', chat_memory: 'mem' }[assetType];
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${suffix}`;
}

export const assetsApi = {
  /** List team assets (supports filtering by type/status/owner) */
  list: (
    teamId: string,
    params?: { asset_type?: AssetType; status?: AssetStatus; owner_user_id?: string }
  ) =>
    metaListAll<Asset>('asset/list', {
      team_id: teamId,
      asset_type: params?.asset_type,
      status: params?.status,
      owner_user_id: params?.owner_user_id,
    }),

  /** Asset Details */
  get: (assetId: string) => metaPost<Asset>('asset/get', { asset_id: assetId }),

  /** Create/Register Asset (two-part: main table + detail table) */
  create: async (
    teamId: string,
    data: {
      asset_type: AssetType;
      name: string;
      description?: string;
      source_type?: string;
      content_ref?: string;
      visibility?: string;
      metadata_json?: string;
      detail?: Record<string, unknown>;
    }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Asset>('asset/create', {
      asset_id: newExternalAssetId(data.asset_type),
      team_id: teamId,
      asset_type: data.asset_type,
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
      source_type: data.source_type ?? 'uploaded',
      content_ref: data.content_ref,
      visibility: data.visibility ?? 'team',
      metadata_json: data.metadata_json,
      detail: data.detail,
    });
  },

  /** Update asset */
  update: (
    assetId: string,
    data: Partial<{ name: string; description: string; status: AssetStatus; visibility: string }>
  ) => metaPost<Asset>('asset/update', { asset_id: assetId, ...data }),

  /** Delete asset (meta asset/delete → physically delete row) */
  delete: async (assetId: string) => {
    await metaPost<{ deleted_ids: string[] }>('asset/delete', { asset_ids: [assetId] });
  },

  /**
   * List the assets accessible by the current user within the specified team (via the backend permission-checker,
   * strictly enforcing visibility × ACL filtering).
   *
   * Difference with asset/list:
   *   - asset/list: Direct SQL query on meta_assets, no visibility/ACL filtering, adminOps perspective.
   *   - asset/list-accessible: First calculate the visible set based on visibility × role × ACL,
   *      private skills are automatically not visible to others; owner is prioritized for access.
   *
   * Optional `visibility` parameter: perform secondary whitelist filtering on the server side (e.g. `['team']` only returns
   (* Shared by the team), to avoid the information leakage risk of "full response body with frontend JS filtering".
   *
   * Used for the "Team Assets" tab —— team members should only see the "Team Public + Personal Private + Explicitly Authorized" sections.
   */
  listAccessible: async (
    teamId: string,
    params?: {
      asset_type?: AssetType;
      action?: 'read' | 'write' | 'use';
      visibility?: Asset['visibility'] | Asset['visibility'][];
    }
  ): Promise<Asset[]> => {
    const me = await getCurrentUser();
    return metaListAll<Asset>('asset/list-accessible', {
      user_id: me.user_id,
      team_id: teamId,
      asset_type: params?.asset_type,
      action: params?.action ?? 'read',
      visibility: params?.visibility,
    });
  },
};
