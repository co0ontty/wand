import type {
  FolderPickerListing,
  FolderPickerRepository,
  FolderPickerRepositoryOptions,
} from "./types";

function cloneListing(listing: FolderPickerListing): FolderPickerListing {
  return {
    currentPath: listing.currentPath,
    items: listing.items.map((item) => ({ ...item })),
  };
}

/** Deterministic local adapter for exercising the repository seam without HTTP. */
export class MemoryFolderPickerRepository implements FolderPickerRepository {
  readonly calls: string[] = [];
  private readonly listings = new Map<string, FolderPickerListing>();
  private readonly errors = new Map<string, string>();

  constructor(listings: ReadonlyArray<FolderPickerListing> = []) {
    for (const listing of listings) this.setListing(listing);
  }

  setListing(listing: FolderPickerListing): void {
    this.listings.set(listing.currentPath, cloneListing(listing));
    this.errors.delete(listing.currentPath);
  }

  setError(path: string, message: string): void {
    this.errors.set(path, message);
  }

  async list(
    path: string,
    options: FolderPickerRepositoryOptions = {},
  ): Promise<FolderPickerListing> {
    if (options.signal?.aborted) throw new Error("请求已取消。");
    const requestedPath = path.trim();
    this.calls.push(requestedPath);
    const error = this.errors.get(requestedPath);
    if (error) throw new Error(error);
    const listing = this.listings.get(requestedPath);
    return listing ? cloneListing(listing) : { currentPath: requestedPath, items: [] };
  }
}
