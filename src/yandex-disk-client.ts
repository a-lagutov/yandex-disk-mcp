/**
 * Yandex Disk REST API client
 * API docs: https://yandex.com/dev/disk-api/doc/en/
 */

const API_BASE = "https://cloud-api.yandex.net/v1/disk";
const API_360_BASE = "https://api360.yandex.net/directory/v1";

export interface DiskInfo {
  total_space: number;
  used_space: number;
  trash_size: number;
  system_folders: Record<string, string>;
}

export interface Resource {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  created: string;
  modified: string;
  mime_type?: string;
  md5?: string;
  public_key?: string;
  public_url?: string;
  _embedded?: {
    items: Resource[];
    total: number;
    limit: number;
    offset: number;
  };
}

export interface Link {
  href: string;
  method: string;
  templated: boolean;
}

/** Shared disk (virtual disk) of a Yandex 360 for Business organization. */
export interface SharedDisk {
  name: string;
  resource_id: string;
  vd_hash: string;
  total_space: number;
  used_space: number;
  trash_size: number;
  permissions: string[];
}

/** Yandex 360 for Business organization. */
export interface Organization {
  id: number;
  name: string;
}

export interface OperationStatus {
  status: "success" | "failure" | "in-progress";
}

export class YandexDiskClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      params?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const { method = "GET", params, body } = options;
    // Absolute URLs (e.g. Yandex 360 API) are used as is, relative ones go to Disk API
    const url = new URL(path.startsWith("https://") ? path : `${API_BASE}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      });
    }

    const headers: Record<string, string> = {
      Authorization: `OAuth ${this.token}`,
      Accept: "application/json",
    };

    const fetchOptions: RequestInit = { method, headers };

    if (body) {
      headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.description || errorJson.message || errorBody;
      } catch {
        errorMessage = errorBody;
      }
      // Yandex 360 API returns errors as { code, message }
      throw new Error(
        `Yandex API error ${response.status}: ${errorMessage}`
      );
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ─── Disk Info ────────────────────────────────────────

  async getDiskInfo(): Promise<DiskInfo> {
    return this.request<DiskInfo>("");
  }

  // ─── Resources ────────────────────────────────────────

  async getResource(
    path: string,
    options?: { limit?: number; offset?: number; sort?: string }
  ): Promise<Resource> {
    const params: Record<string, string> = { path };
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    if (options?.sort) params.sort = options.sort;
    return this.request<Resource>("/resources", { params });
  }

  async createFolder(path: string): Promise<Link> {
    return this.request<Link>("/resources", {
      method: "PUT",
      params: { path },
    });
  }

  async deleteResource(
    path: string,
    permanently: boolean = false
  ): Promise<Link | Record<string, never>> {
    return this.request<Link | Record<string, never>>("/resources", {
      method: "DELETE",
      params: { path, permanently: String(permanently) },
    });
  }

  async copyResource(from: string, to: string, overwrite: boolean = false): Promise<Link> {
    return this.request<Link>("/resources/copy", {
      method: "POST",
      params: { from, path: to, overwrite: String(overwrite) },
    });
  }

  async moveResource(from: string, to: string, overwrite: boolean = false): Promise<Link> {
    return this.request<Link>("/resources/move", {
      method: "POST",
      params: { from, path: to, overwrite: String(overwrite) },
    });
  }

  // ─── Upload / Download ────────────────────────────────

  async getUploadLink(path: string, overwrite: boolean = false): Promise<Link> {
    return this.request<Link>("/resources/upload", {
      params: { path, overwrite: String(overwrite) },
    });
  }

  async uploadByUrl(path: string, url: string): Promise<Link> {
    return this.request<Link>("/resources/upload", {
      method: "POST",
      params: { path, url },
    });
  }

  async getDownloadLink(path: string): Promise<Link> {
    return this.request<Link>("/resources/download", {
      params: { path },
    });
  }

  // ─── Publish / Unpublish ──────────────────────────────

  async publishResource(path: string): Promise<Link> {
    return this.request<Link>("/resources/publish", {
      method: "PUT",
      params: { path },
    });
  }

  async unpublishResource(path: string): Promise<Link> {
    return this.request<Link>("/resources/unpublish", {
      method: "PUT",
      params: { path },
    });
  }

  // ─── Public Resources ─────────────────────────────────

  async getPublicResources(
    options?: { limit?: number; offset?: number; type?: string }
  ): Promise<{ items: Resource[]; total: number }> {
    const params: Record<string, string> = {};
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    if (options?.type) params.type = options.type;
    return this.request<{ items: Resource[]; total: number }>("/resources/public", { params });
  }

  /**
   * Get metadata (and folder contents) of a resource by its public link or key.
   * API: GET /v1/disk/public/resources
   * @param publicKey - public URL (https://yadi.sk/d/...) or public key/hash
   * @param options - relative path inside the public folder and pagination
   */
  async getPublicResource(
    publicKey: string,
    options?: { path?: string; limit?: number; offset?: number; sort?: string }
  ): Promise<Resource> {
    const params: Record<string, string> = { public_key: publicKey };
    if (options?.path) params.path = options.path;
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    if (options?.sort) params.sort = options.sort;
    return this.request<Resource>("/public/resources", { params });
  }

  /**
   * Get a download link for a resource inside a public folder.
   * API: GET /v1/disk/public/resources/download
   * @param publicKey - public URL or key of the shared resource
   * @param path - relative path inside the public folder (optional for files)
   */
  async getPublicDownloadLink(publicKey: string, path?: string): Promise<Link> {
    const params: Record<string, string> = { public_key: publicKey };
    if (path) params.path = path;
    return this.request<Link>("/public/resources/download", { params });
  }

  // ─── Trash ────────────────────────────────────────────

  async getTrash(
    options?: { path?: string; limit?: number; offset?: number }
  ): Promise<Resource> {
    const params: Record<string, string> = { path: options?.path ?? "trash:/" };
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    return this.request<Resource>("/trash/resources", { params });
  }

  async restoreFromTrash(path: string, name?: string, overwrite: boolean = false): Promise<Link> {
    const params: Record<string, string> = { path, overwrite: String(overwrite) };
    if (name) params.name = name;
    return this.request<Link>("/trash/resources/restore", {
      method: "PUT",
      params,
    });
  }

  async clearTrash(path?: string): Promise<Link | Record<string, never>> {
    const params: Record<string, string> = {};
    if (path) params.path = path;
    return this.request<Link | Record<string, never>>("/trash/resources", {
      method: "DELETE",
      params,
    });
  }

  // ─── Flat File List & Last Uploaded ───────────────────

  async getFlatFileList(
    options?: { limit?: number; offset?: number; media_type?: string; sort?: string }
  ): Promise<{ items: Resource[]; limit: number; offset: number }> {
    const params: Record<string, string> = {};
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    if (options?.media_type) params.media_type = options.media_type;
    if (options?.sort) params.sort = options.sort;
    return this.request<{ items: Resource[]; limit: number; offset: number }>("/resources/files", {
      params,
    });
  }

  async getLastUploaded(
    options?: { limit?: number; media_type?: string }
  ): Promise<{ items: Resource[] }> {
    const params: Record<string, string> = {};
    if (options?.limit) params.limit = String(options.limit);
    if (options?.media_type) params.media_type = options.media_type;
    return this.request<{ items: Resource[] }>("/resources/last-uploaded", { params });
  }

  // ─── Shared Disks (Yandex 360) ────────────────────────

  /**
   * List organization shared disks available to the current user.
   * API: GET /v1/disk/virtual-disks/discovery
   * @param orgId - Yandex 360 for Business organization ID
   * @param options - pagination (limit 1–100, offset)
   * @returns shared disks with the user's permissions on each
   */
  async getSharedDisks(
    orgId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ items: SharedDisk[]; total: number; limit: number; offset: number }> {
    const params: Record<string, string> = { org_id: orgId };
    if (options?.limit) params.limit = String(options.limit);
    if (options?.offset) params.offset = String(options.offset);
    return this.request<{ items: SharedDisk[]; total: number; limit: number; offset: number }>(
      "/virtual-disks/discovery",
      { params }
    );
  }

  /**
   * List Yandex 360 organizations available to the token.
   * API: GET https://api360.yandex.net/directory/v1/org
   * Requires the `directory:read_organization` OAuth scope.
   * @returns organizations the user belongs to
   */
  async getOrganizations(): Promise<Organization[]> {
    const result = await this.request<{ organizations?: Organization[] }>(
      `${API_360_BASE}/org`,
      { params: { pageSize: "100" } }
    );
    return result.organizations ?? [];
  }

  // ─── Operations ───────────────────────────────────────

  async getOperationStatus(operationId: string): Promise<OperationStatus> {
    return this.request<OperationStatus>(`/operations/${operationId}`);
  }
}
