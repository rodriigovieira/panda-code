import { Worker } from "node:worker_threads";
import type {
  TranscriptIndexMetadata,
  TranscriptIndexPage,
  TranscriptIndexSearchDocument,
  TranscriptIndexSearchHit,
  TranscriptIndexWorkerRequest,
  TranscriptIndexWorkerResponse,
  TranscriptRegistration,
} from "../shared/transcript-index";

type WorkerRequest = TranscriptIndexWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export class TranscriptIndexClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly workerPath: string,
    private readonly directory: string,
    private readonly home: string,
  ) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath, { workerData: { directory: this.directory, home: this.home } });
    worker.on("message", (response: TranscriptIndexWorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error));
    });
    worker.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker = undefined;
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        const error = new Error(`Transcript index worker exited with code ${code}.`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      }
      this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private request<T>(request: WorkerRequest): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ensureWorker().postMessage({ ...request, id });
    });
  }

  register(registrations: TranscriptRegistration[]): Promise<Array<{ key: string; path?: string }>> {
    return this.request({ type: "register", registrations });
  }

  page(key: string, beforeOffset?: number, maxRecords = 800): Promise<TranscriptIndexPage> {
    return this.request({ type: "page", key, beforeOffset, maxRecords });
  }

  metadata(key: string, refresh = false): Promise<TranscriptIndexMetadata> {
    return this.request({ type: refresh ? "refresh" : "metadata", key });
  }

  search(query: string, documents: TranscriptIndexSearchDocument[], limit = 100): Promise<TranscriptIndexSearchHit[]> {
    return this.request({ type: "search", query, documents, limit });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
