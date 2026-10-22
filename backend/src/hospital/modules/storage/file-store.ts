import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Where uploaded documents (consent forms, outside reports, scans, radiology images) are kept. The rest of the app only sees
 * this interface, so the place can change without touching it:
 *
 *  - 'memory'  a private store that vanishes when the process stops (tests only)
 *  - 'local'   a folder on the server's disk (your own computer, or a server with a persistent disk)
 *  - 'none'    nothing is configured: uploads are refused with a clear message. This is the production default, because a hosting
 *              plan without a persistent disk would silently lose every document at the next deploy
 *
 * Patient documents are health records: when real patient data goes in, the store should be in India (an object store in the
 * Mumbai or Hyderabad region, with encryption at rest). That is one more implementation of this interface; nothing else changes.
 */
export interface FileStore {
  readonly kind: "memory" | "local" | "none";
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export class MemoryFileStore implements FileStore {
  readonly kind = "memory" as const;
  private readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
}

export class LocalFileStore implements FileStore {
  readonly kind = "local" as const;
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }

  /** Keys are built by the app (ids only), but a key that tried to leave the folder is refused anyway. */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + "\\") && !path.startsWith(this.root + "/")) throw new Error("invalid storage key");
    return path;
  }

  async put(key: string, data: Buffer) {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string) {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

/** Nothing configured: reading finds nothing, writing says why it cannot. */
export class NoFileStore implements FileStore {
  readonly kind = "none" as const;
  async put(): Promise<void> {
    throw new Error("no file store is configured");
  }
  async get() {
    return null;
  }
}

export function createFileStore(options: { kind: FileStore["kind"] | "auto"; dir?: string; nodeEnv: string }): FileStore {
  const kind = options.kind === "auto" ? (options.nodeEnv === "test" ? "memory" : options.nodeEnv === "production" ? "none" : "local") : options.kind;
  if (kind === "memory") return new MemoryFileStore();
  if (kind === "local") return new LocalFileStore(options.dir ?? "./data/files");
  return new NoFileStore();
}
