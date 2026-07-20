import { ConfigService } from '@nestjs/config';

import { AiDataResidencyService } from './ai-data-residency.service';

type DeploymentRow = {
  id: string;
  enabled: boolean;
  region?: string | null;
  base_url?: string | null;
  openai_project?: string | null;
  api_key_ciphertext?: string | null;
  allowed_regions?: string[] | null;
};

describe('AiDataResidencyService', () => {
  const encryption = { decrypt: jest.fn((v: string) => v.replace('enc:', '')) };

  const make = (env: Record<string, unknown>, row: DeploymentRow | null) => {
    const deployments = { findOne: jest.fn().mockResolvedValue(row) };
    const service = new AiDataResidencyService(
      new ConfigService(env),
      encryption as never,
      deployments as never,
    );
    return { service, deployments };
  };

  beforeEach(() => encryption.decrypt.mockClear());

  it('is not enforced (and never touches the DB) when residency is disabled', async () => {
    const { service, deployments } = make({}, null);
    const decision = await service.resolve('tenant-1');
    expect(decision.enforced).toBe(false);
    expect(deployments.findOne).not.toHaveBeenCalled();
  });

  it('is not enforced when the tenant has no deployment row', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, null);
    expect((await service.resolve('tenant-1')).enforced).toBe(false);
  });

  it('is not enforced when the deployment exists but is disabled', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: false, region: 'eu',
    });
    expect((await service.resolve('tenant-1')).enforced).toBe(false);
  });

  it('FAILS CLOSED when an enabled deployment has no region', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: null, api_key_ciphertext: 'enc:key',
    });
    await expect(service.resolve('tenant-1')).rejects.toThrow(/data residency/i);
  });

  it('FAILS CLOSED when the region is not in the allow-list', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: 'eu', allowed_regions: ['us'], api_key_ciphertext: 'enc:key',
    });
    await expect(service.resolve('tenant-1')).rejects.toThrow();
  });

  it('FAILS CLOSED when the enabled deployment has no API key', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: 'eu', api_key_ciphertext: null,
    });
    await expect(service.resolve('tenant-1')).rejects.toThrow();
  });

  it('never redirects to the global region on failure (no silent fallback)', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: 'eu', api_key_ciphertext: null,
    });
    // The contract is "throw", never "return { enforced: false }".
    await expect(service.resolve('tenant-1')).rejects.toBeDefined();
  });

  it('FAILS CLOSED (SSRF) when the base URL points at an internal host', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: 'eu', api_key_ciphertext: 'enc:key',
      base_url: 'https://169.254.169.254/latest', allowed_regions: ['eu'],
    });
    await expect(service.resolve('tenant-1')).rejects.toThrow();
  });

  it('surfaces the AI_COMPLIANCE_ROUTE_UNAVAILABLE reason on fail-closed', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: null, api_key_ciphertext: 'enc:key',
    });
    await expect(service.resolve('tenant-1')).rejects.toMatchObject({
      context: { reason: 'AI_COMPLIANCE_ROUTE_UNAVAILABLE' },
    });
  });

  it('enforces a valid deployment and returns decrypted, region-pinned options', async () => {
    const { service } = make({ AI_DATA_RESIDENCY_ENABLED: 'true' }, {
      id: 'd1', enabled: true, region: 'eu', allowed_regions: ['eu', 'us'],
      base_url: 'https://eu.api.example.com/v1', openai_project: 'proj_eu',
      api_key_ciphertext: 'enc:secret-key',
    });
    const decision = await service.resolve('tenant-1');
    expect(decision.enforced).toBe(true);
    expect(decision.region).toBe('eu');
    expect(decision.deploymentId).toBe('d1');
    expect(decision.options).toEqual({
      apiKey: 'secret-key',
      baseURL: 'https://eu.api.example.com/v1',
      project: 'proj_eu',
    });
    expect(encryption.decrypt).toHaveBeenCalledWith('enc:secret-key');
  });
});
