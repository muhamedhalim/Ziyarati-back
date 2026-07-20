import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

import {
  AiBatchHandle,
  AiBatchLineResult,
  AiBatchProvider,
  AiBatchSubmitInput,
  buildBatchJsonl,
  parseBatchResultsJsonl,
} from './ai-batch-provider.interface';
import { OpenAiClientProvider } from './openai-client.provider';
import { OpenAiRequestPolicy } from './openai-request-policy';
import { mapOpenAiBatchStatus } from '../execution/ai-execution.constants';

/**
 * OpenAI Batch API adapter.
 *
 * Uses the REAL Batch API — upload a JSONL input file, create a batch, poll its
 * status, then download the output/error files and bind lines by `custom_id`. It
 * is NOT a loop over the synchronous Chat/Embeddings API.
 *
 * When DATA RESIDENCY is enforced for a tenant, requests are dialed through that
 * tenant's regional client (via OpenAiClientProvider). Otherwise the global
 * client is used. When neither a global key nor a residency deployment exists,
 * `isConfigured()` is false and the batch service skips submission.
 */
@Injectable()
export class OpenAiBatchProvider implements AiBatchProvider {
  readonly name = 'openai';
  private readonly logger = new Logger('OpenAiBatchProvider');
  private readonly client?: OpenAI;
  private readonly policy: OpenAiRequestPolicy;
  private readonly defaultWindow: string;

  constructor(
    private readonly config: ConfigService,
    private readonly clients: OpenAiClientProvider,
  ) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.defaultWindow = config.get<string>('AI_BATCH_COMPLETION_WINDOW', '24h');
    this.policy = new OpenAiRequestPolicy(
      Number(config.get('OPENAI_PROVIDER_MAX_RETRIES', 2)),
      Number(config.get('OPENAI_RETRY_BASE_MS', 500)),
      this.logger,
    );
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        timeout: Number(config.get('OPENAI_REQUEST_TIMEOUT_MS', 30_000)),
        maxRetries: 0,
      });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async submit(input: AiBatchSubmitInput): Promise<AiBatchHandle> {
    const client = await this.clientFor(input.tenantId);
    const jsonl = buildBatchJsonl(input.requests);
    const uploaded = await this.policy.execute(
      async () =>
        client.files.create({
          file: await toFile(Buffer.from(jsonl, 'utf8'), 'batch-input.jsonl'),
          purpose: 'batch',
        }),
      'files.create',
    );
    const inputFileId = uploaded.value.id;

    const created = await this.policy.execute(
      () =>
        client.batches.create({
          input_file_id: inputFileId,
          endpoint: input.endpoint as '/v1/embeddings' | '/v1/chat/completions',
          completion_window: (input.completionWindow ?? this.defaultWindow) as '24h',
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }),
      'batches.create',
    );
    return this.toHandle(created.value, inputFileId);
  }

  async poll(tenantId: string, externalId: string): Promise<AiBatchHandle> {
    const client = await this.clientFor(tenantId);
    const batch = await this.policy.execute(() => client.batches.retrieve(externalId), 'batches.retrieve');
    return this.toHandle(batch.value);
  }

  async cancel(tenantId: string, externalId: string): Promise<AiBatchHandle> {
    const client = await this.clientFor(tenantId);
    const batch = await this.policy.execute(() => client.batches.cancel(externalId), 'batches.cancel');
    return this.toHandle(batch.value);
  }

  async fetchResults(
    tenantId: string,
    handle: AiBatchHandle,
  ): Promise<{ outputs: AiBatchLineResult[]; errors: AiBatchLineResult[] }> {
    const client = await this.clientFor(tenantId);
    const outputs = handle.outputFileId
      ? parseBatchResultsJsonl(await this.downloadFile(client, handle.outputFileId))
      : [];
    const errors = handle.errorFileId
      ? parseBatchResultsJsonl(await this.downloadFile(client, handle.errorFileId))
      : [];
    return { outputs, errors };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async clientFor(tenantId: string): Promise<OpenAI> {
    // Residency override (per tenant) wins; otherwise the global client. A
    // fail-closed residency throw propagates here and aborts the batch.
    const override = await this.clients.forTenant(tenantId);
    const client = override ?? this.client;
    if (!client) throw new Error('OPENAI_API_KEY is not configured');
    return client;
  }

  private async downloadFile(client: OpenAI, fileId: string): Promise<string> {
    const res = await this.policy.execute(() => client.files.content(fileId), 'files.content');
    return res.value.text();
  }

  private toHandle(
    batch: { id: string; status: string; input_file_id?: string; output_file_id?: string | null; error_file_id?: string | null; request_counts?: { total?: number; completed?: number; failed?: number } },
    inputFileId?: string,
  ): AiBatchHandle {
    return {
      externalId: batch.id,
      status: mapOpenAiBatchStatus(batch.status),
      inputFileId: inputFileId ?? batch.input_file_id ?? null,
      outputFileId: batch.output_file_id ?? null,
      errorFileId: batch.error_file_id ?? null,
      counts: {
        total: batch.request_counts?.total ?? 0,
        completed: batch.request_counts?.completed ?? 0,
        failed: batch.request_counts?.failed ?? 0,
      },
    };
  }
}
